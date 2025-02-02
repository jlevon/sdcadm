/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var assert = require('assert-plus');
var sprintf = require('extsprintf').sprintf;
var util = require('util');
var format = util.format;
var path = require('path');
var fs = require('fs');

var vasync = require('vasync');
var mkdirp = require('mkdirp');
var uuid = require('node-uuid');

var errors = require('../errors');
var UpdateError = errors.UpdateError;

var common = require('../common');
var ur = require('../ur');

var Procedure = require('./procedure').Procedure;

/**
 * Procedure for updating the different agent services.
 */
function UpdateDockerlogger(options) {
    assert.arrayOfObject(options.changes, 'options.changes');
    this.changes = options.changes;
}
util.inherits(UpdateDockerlogger, Procedure);


UpdateDockerlogger.prototype.summarize = function udSummarize() {
    return this.changes.map(function (ch) {
        var img = ch.image;
        var out;

        if (ch.type === 'update-service') {
            out = [
                sprintf('update "dockerlogger" service to image %s ', img.uuid),
                common.indent(sprintf('%s@%s', img.name, img.version)),
                sprintf('in %s servers', (
                            ch.insts.length ?
                            ch.insts.length : 'all the setup'))
            ];
        } else if (ch.type === 'update-instance') {
            out = [sprintf('update "%s" instance of "dockerlogger" service',
                        ch.instance.instance),
                        common.indent(sprintf('to image %s (%s@%s)',
                        img.uuid, img.name, img.version))];
        } else if (ch.type === 'create-instances') {
            if (ch.insts.length > 1) {
                out = [sprintf('create new instances of "%s" service',
                        ch.service.name),
                    common.indent(sprintf('using image %s (%s@%s)',
                        img.uuid, img.name, img.version)),
                    common.indent(sprintf('on %d servers:',
                        ch.insts.length)),
                    ch.insts.map(function (inst) {
                        return common.indent(8, sprintf('%s (%s)',
                            inst.server, inst.hostname));
                    }).join(', ')
                ];
            } else {
                out = [sprintf('create a new instance of "%s" service',
                            ch.service.name),
                            common.indent(sprintf('on server %s (%s)',
                                ch.insts[0].server, ch.insts[0].hostname)),
                            common.indent(sprintf('using image %s (%s@%s)',
                            img.uuid, img.name, img.version))];
            }
        }
        return out.join('\n');
    }).join('\n');
};



UpdateDockerlogger.prototype.execute = function udExecute(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.plan, 'opts.plan');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.ui, 'opts.ui');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.wrkDir, 'opts.wrkDir');
    assert.optionalNumber(opts.concurrency, 'opts.concurrency');
    assert.func(callback, 'callback');

    var self = this;
    var progress = opts.progress;
    var ui = opts.ui;
    var sdcadm = opts.sdcadm;
    var log = opts.log;
    var svc;
    var concurrency = opts.concurrency || 1;

    var downloadDir = '/var/tmp';
    var filepath;
    var fname;

    function updateDockerlogger(change, nextSvc) {

        log.debug({change: change}, 'updateDockerlogger');

        var context = {
            progress: progress,
            log: log,
            sdcadm: sdcadm,
            urConnection: null,
            urServersToUpdate: null
        };

        vasync.pipeline({arg: context, funcs: [
            function ensureSdcApp(_, next) {
                sdcadm.ensureSdcApp({}, next);
            },
            /*
             * Check if docker service is already on SAPI. Otherwise,
             * inform the user how to add it.
             */
            function checkDockerSvcOnSapi(_, next) {
                sdcadm.getSvc({
                    svc: 'docker',
                    app: sdcadm.sdcApp.uuid,
                    allowNone: true
                }, function (err, service) {
                    if (err) {
                        next(err);
                    } else if (!service) {
                        next(new UpdateError(
                            'docker service does not exist. Please run:\n' +
                            '\n    sdcadm experimental update-docker\n' +
                            '\n\nbefore trying to install dockerlogger'));
                    } else {
                        next();
                    }
                });
            },

            function getOrCreateDockerloggerSvc(_, next) {
                sdcadm.sapi.listServices({
                    name: 'dockerlogger'
                }, function (err, svcs) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'sapi'));
                        return;
                    }

                    if (svcs.length) {
                        svc = svcs[0];
                        next();
                        return;
                    }
                    progress('Creating "dockerlogger" servivce');
                    sdcadm.sapi.createService(
                        'dockerlogger', sdcadm.sdcApp.uuid, {
                        params: {
                            image_uuid: change.image.uuid
                        },
                        type: 'agent'
                    }, function (er2, service) {
                        if (er2) {
                            next(new errors.SDCClientError(er2, 'sapi'));
                            return;
                        }
                        svc = service;
                        next();
                    });
                });
            },

            function listServers(ctx, next) {
                // Get all servers to validate if unsetup servers are selected.
                sdcadm.cnapi.listServers({}, function (err, servers) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ctx.allServers = servers;
                    next();
                });
            },

            // TOOLS-1381: In case we have SAPI instances whose UUID is the
            // same than some server UUID, we'll delete them. Dockerlogger
            // setup will recreate them properly
            function cleanupSAPIInsts(ctx, next) {
                if (!change.insts.length || change.type !== 'update-service') {
                    next();
                    return;
                }

                var allServersUUIDS = ctx.allServers.map(function (c) {
                    return c.uuid;
                });

                var instancesToDelete = change.insts.filter(function (i) {
                    return allServersUUIDS.indexOf(i.instance) !== -1;
                }).map(function (i) {
                    return i.instance;
                });

                if (!instancesToDelete.length) {
                    next();
                    return;
                }

                change.insts = change.insts.filter(function (i) {
                    return instancesToDelete.indexOf(i.instance) === -1;
                });

                progress('Fixing dockerlogger instances UUIDs in SAPI');

                vasync.forEachPipeline({
                    func: function dropInstance(inst, nextInst) {
                        sdcadm.sapi.deleteInstance(inst, nextInst);
                    },
                    inputs: instancesToDelete
                }, next);
            },

            function validateServersToUpdate(ctx, next) {
                progress('Validating servers');

                if (!change.insts.length) {
                    ctx.serversToUpdate = ctx.allServers.filter(function (svr) {
                        return svr.setup;
                    });
                    next();
                } else {
                    var i, n;
                    var serverFromUuid = {};
                    var serverFromHostname = {};
                    for (i = 0; i < ctx.allServers.length; i++) {
                        n = ctx.allServers[i];
                        serverFromUuid[n.uuid] = n;
                        serverFromHostname[n.hostname] = n;
                    }

                    ctx.serversToUpdate = [];
                    var serverToUpdateFromUuid = {};
                    var unsetupServerIds = [];
                    var notFoundServerIds = [];

                    change.insts.forEach(function (inst) {
                        n = serverFromUuid[inst.server];
                        if (n) {
                            // Avoid drop dupes in `opts.servers`.
                            if (!serverToUpdateFromUuid[inst.server]) {
                                ctx.serversToUpdate.push(n);
                                serverToUpdateFromUuid[n.uuid] = true;
                            }
                            if (!n.setup) {
                                unsetupServerIds.push(n);
                            }
                        } else {
                            notFoundServerIds.push(n);
                        }
                    });

                    if (notFoundServerIds.length) {
                        log.error({err: new Error(format(
                            '%d of %d selected servers ' +
                            'were not found in CNAPI: %s',
                            notFoundServerIds.length, change.insts.length,
                            notFoundServerIds.join(', ')))});
                    } else if (unsetupServerIds.length) {
                        log.error({err: new Error(format(
                            '%d of %d selected servers are not setup: %s',
                            unsetupServerIds.length, change.insts.length,
                            unsetupServerIds.join(', ')))});
                    }
                    next();
                }
            },

            function urDiscoveryGetReady(ctx, next) {
                if (!ctx.serversToUpdate.length) {
                    next();
                    return;
                }
                sdcadm.getUrConnection(function (err, urconn) {
                    if (err) {
                        log.debug({
                            err: err
                        }, 'ur error');
                        next(new errors.InternalError({
                            cause: err,
                            message: 'ur failure'
                        }));
                        return;
                    }

                    ctx.urConnection = urconn;
                    next();
                });
            },

            function urDiscovery(ctx, next) {
                if (!ctx.serversToUpdate.length) {
                    next();
                    return;
                }
                progress('Checking servers availability');

                common.urDiscovery({
                    sdcadm: sdcadm,
                    progress: progress,
                    nodes: ctx.serversToUpdate.map(function (n) {
                        assert.uuid(n.uuid);
                        return n.uuid;
                    }),
                    urconn: ctx.urConnection
                }, function (err, urAvailServers) {
                    if (err) {
                        next(err);
                        return;
                    }
                    ctx.urServersToUpdate = urAvailServers;
                    next();
                });
            },

            // TODO: Check file is not already at downloadDir from a previous
            // run (including checksum)
            function getImgFileFromLocalImgapi(ctx, next) {
                if (!ctx.urServersToUpdate.length) {
                    next();
                    return;
                }
                progress('Getting image file from local imgapi');
                filepath = path.resolve(downloadDir,
                'dockerlogger-' + change.image.uuid + '.sh');
                sdcadm.imgapi.getImageFile(change.image.uuid, filepath,
                        function (err, res) {
                    if (err) {
                        next(new errors.SDCClientError(err, 'imgapi'));
                        return;
                    }
                    next();
                });
            },

            // TODO: Check the file is not already in assetsdir from a
            // previous run, checksum included.
            function copyImgFileToAssets(ctx, next) {
                if (!ctx.urServersToUpdate.length) {
                    next();
                    return;
                }
                var assetsdir = '/usbkey/extra/dockerlogger';
                progress('Copying dockerlogger to assets dir: %s', assetsdir);
                var argv = ['cp', filepath, assetsdir];
                mkdirp.sync(assetsdir);
                common.execFilePlus({
                    argv: argv,
                    log: log
                }, function (err, stderr, stdout) {
                    log.trace({
                        cmd: argv.join(' '),
                        err: err,
                        stdout: stdout,
                        stderr: stderr
                    }, 'ran cp command');
                    if (err) {
                        next(new errors.InternalError({
                            message: format('error copying shar file to %s',
                                             assetsdir),
                            cmd: argv.join(' '),
                            stdout: stdout,
                            stderr: stderr,
                            cause: err
                        }));
                        return;
                    }
                    next();
                });
            },

            function updateLogger(ctx, next) {
                if (!ctx.urServersToUpdate.length) {
                    next();
                    return;
                }
                if (change.type === 'create-instances') {
                    progress('Starting dockerlogger instance creation');
                } else {
                    progress('Starting dockerlogger update on %d servers',
                        ctx.urServersToUpdate.length);
                }
                fname = path.basename(filepath);
                var ip = sdcadm.config.assets_admin_ip;
                var f = fname;
                var ff = '/var/tmp/' + f;
                // Do not override log file if we run installer more than once
                // for the same version.
                // TODO(trent): Won't these build up? Should clean these out.
                var lf = '/var/tmp/' + f + '_' + uuid() + '_install.log';


                var downloadCmd = [
                    'cd /var/tmp;',
                    '',
                    /*
                     * Exit 22 if cannot download the installer file (curl code)
                     */
                    '/usr/bin/curl -kOsf http://' + ip +
                        '/extra/dockerlogger/' + f,
                    'if [[ "$?" -ne "0" ]]; then',
                    '   exit $?',
                    'fi',
                    ''
                ].join('\n');

                var installCmd = [
                    'cd /var/tmp;',
                    '',
                    /*
                     * Exit 30 if installer fails
                     */
                    '/usr/bin/bash ' + ff + ' </dev/null >' + lf + ' 2>&1',
                    'if [[ "$?" -ne "0" ]]; then',
                    '   exit 30',
                    'fi',
                    ''
                ].join('\n');

                vasync.forEachPipeline({
                    inputs: [
                        {
                            str: downloadCmd,
                            progbarName: 'Downloading dockerlogger',
                            timeout: 10 * 60 * 1000
                        },
                        {
                            str: installCmd,
                            progbarName: 'Installing dockerlogger',
                            timeout: 20 * 60 * 1000
                        }
                    ],
                    func: function runUrQueue(cmd, nextCmd) {
                        assert.object(ctx.urConnection, 'ctx.urConnection');
                        var queueOpts = {
                            sdcadm: sdcadm,
                            urConnection: ctx.urConnection,
                            log: log,
                            ui: ui,
                            command: cmd.str,
                            concurrency: concurrency,
                            timeout: cmd.timeout
                        };

                        ui.barStart({
                            name: cmd.progbarName,
                            size: ctx.urServersToUpdate.length
                        });
                        log.trace({
                            command: cmd.str,
                            concurrency: concurrency
                        }, 'runUrQueue');

                        var rq = ur.runQueue(queueOpts,
                                function runQueueCb(err, results) {
                            ui.barEnd();

                            if (err) {
                                nextCmd(new errors.UpdateError(
                                    err, 'unexpected runQueue error'));
                                return;
                            }

                            var errs = [];
                            results.forEach(function (r) {
                                if (r.error || r.result.exit_status !== 0) {
                                    errs.push(new errors.UpdateError(format(
                                        '%s failed on server %s (%s): %j',
                                        cmd.progbarName, r.uuid, r.hostname,
                                        r.error || r.result)));
                                }
                            });
                            if (errs.length === 1) {
                                nextCmd(errs[0]);
                            } else if (errs.length > 1) {
                                nextCmd(new errors.MultiError(errs));
                            } else {
                                nextCmd();
                            }
                        });

                        rq.on('success', function onSuccess(server, result) {
                            // A non-zero exit from the command is a "success".
                            if (result.exit_status !== 0) {
                                var errmsg = format(
                                    '%s failed on server %s (%s): %j',
                                    cmd.progbarName, server.uuid,
                                    server.hostname, result);
                                if (cmd.logFile) {
                                    errmsg += ' (log file on server: ' +
                                        cmd.logFile + ')';
                                }
                                ui.error(errmsg);
                            }
                        });

                        rq.start();
                        ctx.urServersToUpdate.forEach(function (us) {
                            rq.add_server(us);
                        });
                        rq.close();
                    }
                }, function doneCmds(err, _) {
                    next(err);
                });
            },

            function doCleanup(ctx, next) {
                if (!ctx.urServersToUpdate.length) {
                    next();
                    return;
                }
                progress('Deleting temporary %s', filepath);
                fs.unlink(filepath, function (err) {
                    if (err) {
                        log.warn(err, 'could not unlink %s', filepath);
                    }
                    next();
                });
            },

            function updateSvcImage(_, next) {
                if (change.type !== 'update-service') {
                    next();
                    return;
                }
                progress('Updating "dockerlogger" service in SAPI');
                sdcadm.sapi.updateService(svc.uuid, {
                    params: {
                        image_uuid: change.image.uuid
                    }
                }, next);
            }

        ]}, nextSvc);
    }

    vasync.forEachPipeline({
        inputs: self.changes,
        func: updateDockerlogger
    }, callback);
};

// --- exports

module.exports = {
    UpdateDockerlogger: UpdateDockerlogger
};
// vim: set softtabstop=4 shiftwidth=4:
