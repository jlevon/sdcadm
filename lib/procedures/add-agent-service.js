/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

/*
 * Procedure to add a new agent service to Triton, including service creation in
 * SAPI and instances creation into the given servers using the provided (or
 * latest available) image.
 */
const util = require('util'),
    format = util.format;

const assert = require('assert-plus');
const sprintf = require('extsprintf').sprintf;
const vasync = require('vasync');
const VError = require('verror');

const common = require('../common');
const DownloadImages =
    require('../procedures/download-images').DownloadImages;
const errors = require('../errors'),
    UpdateError = errors.UpdateError,
    SDCClientError = errors.SDCClientError;
const Procedure = require('./procedure').Procedure;
const steps = require('../steps');

function AddAgentServiceProcedure(options) {
    assert.object(options, 'options');
    assert.string(options.svcName, 'options.svcName');
    assert.number(options.concurrency, 'options.concurrency');
    assert.optionalString(options.image, 'options.image');
    assert.optionalString(options.channel, 'options.channel');

    assert.optionalArrayOfString(options.includeServerNames,
        'options.includeServerNames');
    assert.optionalArrayOfString(options.excludeServerNames,
        'options.excludeServerNames');

    assert.optionalArrayOfString(options.dependencies, 'options.dependencies');

    this.svcData = {
        name: options.svcName,
        params: {
            image_uuid: 'TO_FILL_IN',
            tags: {
                smartdc_role: options.svcName,
                smartdc_type: 'core'
            }
        },
        metadata: {
            SERVICE_NAME: options.svcName
        },
        type: 'agent'
    };


    this.svcName = options.svcName;
    this.concurrency = options.concurrency;
    this.imageArg = options.image || 'latest';
    this.channelRef = options.channel || 'default';
    this.dependencies = options.dependencies || [];
    this.includeServerNames = options.includeServerNames;
    this.excludeServerNames = options.excludeServerNames;
}

util.inherits(AddAgentServiceProcedure, Procedure);

/*
 * Go through existing service details in Triton, if any, and retrieve all the
 * information required in order to proceed to service addition for the current
 * Triton setup.
 *
 * Object properties set by this method are:
 * - @svc (Object) In case the service already exists
 * - @svcImg (Object)
 * - @needToDownloadImg (Boolean)
 * - @servers (Array of Strings) UUIDs of the server to create svc instances
 */
AddAgentServiceProcedure.prototype.prepare =
function prepare(opts, cb) {
    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');

    const self = this;
    const sdcadm = opts.sdcadm;

    vasync.pipeline({
        arg: {},
        funcs: [
            sdcadm.ensureSdcApp.bind(sdcadm),

            function checkDependencies(_, next) {
                if (self.dependencies.length === 0) {
                    next();
                    return;
                }
                let missingSvcs = [];
                vasync.forEachParallel({
                    inputs: self.dependencies,
                    func: function checkSvcPresent(svc, nextSvc) {
                        sdcadm.sapi.listServices({
                            name: svc,
                            application_uuid: sdcadm.sdcApp.uuid
                        }, function (svcErr, svcs) {
                            if (svcErr) {
                                nextSvc(svcErr);
                                return;
                            }
                            if (!svcs.length) {
                                missingSvcs.push(svc);
                            }
                            nextSvc();
                        });
                    }
                }, function paraCb(paraErr) {
                    if (paraErr) {
                        next(paraErr);
                        return;
                    }

                    if (missingSvcs.length) {
                        let message;
                        if (missingSvcs.length === 1) {
                            message = [
                                util.format('The "%s" service is required',
                                    missingSvcs[0]),
                                util.format('Please, install it with ' +
                                    '`sdcadm post-setup %s`.',
                                    missingSvcs[0])
                            ];
                        } else {
                            message = [
                                util.format('The "%s" services are required',
                                    missingSvcs.join('", "')),
                                'Please, install them with:'
                            ];
                            missingSvcs.forEach(function addMissingSvc(svc) {
                                message.push(util.format(
                                    '`sdcadm post-setup %s`', svc));
                            });
                        }
                        next(new errors.UpdateError(message.join('\n')));
                        return;
                    }
                    next();
                });
            },

            function getChannel(_, next) {
                if (self.channelRef === 'default') {
                    sdcadm.getDefaultChannel(function (err, channel) {
                        if (err) {
                            next(err);
                            return;
                        }
                        self.channel = channel;
                        next();
                    });
                } else {
                    self.channel = self.channelRef;
                    next();
                }
            },

            function getSvc(_, next) {
                sdcadm.sapi.listServices({
                    name: self.svcName,
                    application_uuid: sdcadm.sdcApp.uuid
                }, function listSvcsCb(svcErr, svcs) {
                    if (svcErr) {
                        next(svcErr);
                        return;
                    }
                    if (svcs.length) {
                        self.svc = svcs[0];
                    }
                    next();
                });
            },

            // Find the appropriate image to use. We use the `--image` option
            // arg to choose the appropriate image (limiting to the image name
            // for this service).
            //
            // This either errors out or sets `this.svcImg` to the image
            // manifest and `this.needToDownloadImg = true` if the image needs
            // to be downloaded from the image server.
            function getSvcImg(_, next) {
                const imgName = sdcadm.config.imgNameFromSvcName[self.svcName];
                // Just in case it's undefined and we finish up retrieving a
                // really huge list from updates.jo
                assert.string(imgName, 'imgName');

                if (self.imageArg === 'latest') {
                    sdcadm.updates.listImages({
                        name: imgName,
                        channel: self.channel
                    }, function (listErr, imgs) {
                        if (listErr) {
                            next(listErr);
                        } else if (imgs && imgs.length) {
                            // TODO presuming sorted by published_at
                            self.svcImg = imgs[imgs.length - 1];

                            sdcadm.imgapi.getImage(
                                self.svcImg.uuid,
                                function (getErr, img) {
                                    if (getErr && getErr.body &&
                                        getErr.body.code ===
                                        'ResourceNotFound') {
                                        self.needToDownloadImg = true;
                                        next();
                                    } else if (getErr) {
                                        next(getErr);
                                    } else {
                                        assert.object(img, 'img');
                                        self.needToDownloadImg = false;
                                        next();
                                    }
                                }
                            );
                        } else {
                            next(new errors.UpdateError(
                                format('no "%s" image found in %s channel of ' +
                                    'updates server',
                                    imgName, self.channel)));
                        }
                    });
                } else if (self.imageArg === 'current') {
                    sdcadm.imgapi.listImages({
                        name: imgName
                    }, function (err, imgs) {
                        if (err) {
                            next(err);
                        } else if (imgs && imgs.length) {
                            // TODO presuming sorted by published_at
                            self.svcImg = imgs[imgs.length - 1];
                            self.needToDownloadImg = false;
                            next();
                        } else {
                            next(new errors.UpdateError(format(
                                'no "%s" image found in this DC\'s IMGAPI',
                                imgName)));
                        }
                    });
                } else if (common.UUID_RE.test(self.imageArg)) {
                    // imageArg is the UUID of an image in the local IMGAPI or
                    // in updates.joyent.com.
                    sdcadm.getImage({
                        uuid: self.imageArg,
                        channel: self.channel
                    }, function (err, img) {
                        if (err && err.body &&
                            err.body.code === 'ResourceNotFound') {
                            next(new errors.UpdateError(format(
                                'no image "%s" was found in the %s channel of' +
                                ' the updates server',
                                self.imageArg, self.channel)));
                        } else if (err) {
                            next(err);
                        } else {
                            assert.object(img, 'img');
                            if (img.name !== imgName) {
                                next(new errors.UpdateError(format(
                                    'image "%s" (%s) is not a "%s" image',
                                    self.imageArg, img.name, imgName)));
                            } else {
                                self.svcImg = img;
                                // `SdcAdm.getImage` doesn't explicitly tell us
                                // if the image is already in the DC, but we
                                // can infer that from `img.channels`. If it
                                // has that field, then it was a response from
                                // querying updates.joyent.com.
                                self.needToDownloadImg =
                                    img.hasOwnProperty('channels');
                                next();
                            }
                        }
                    });
                } else {
                    // imageArg must be an image `version`.
                    sdcadm.imgapi.listImages({
                        name: imgName,
                        version: self.imageArg
                    }, function (localErr, localImgs) {
                        if (localErr && !(localErr.body &&
                            localErr.body.code === 'ResourceNotFound')) {
                            next(localErr);
                        } else if (!localErr && localImgs &&
                            localImgs.length > 0) {
                            // TODO presuming sorted by published_at
                            self.svcImg = localImgs[localImgs.length - 1];
                            self.needToDownloadImg = false;
                            next();
                        } else {
                            // Look in updates.joyent.com.
                            sdcadm.updates.listImages({
                                name: imgName,
                                version: self.imageArg,
                                channel: self.channel
                            }, function (updatesErr, updatesImgs) {
                                if (updatesErr) {
                                    next(updatesErr);
                                } else if (updatesImgs &&
                                    updatesImgs.length > 0) {
                                    // TODO presuming sorted by published_at
                                    self.svcImg = updatesImgs[
                                        updatesImgs.length - 1];
                                    self.needToDownloadImg = true;
                                    next();
                                } else {
                                    next(new errors.UpdateError(format(
                                        'no "%s" image with version "%s" ' +
                                        'found in the %s channel of the ' +
                                        'updates server',
                                        imgName, self.imageArg,
                                        self.channel)));
                                }
                            });
                        }
                    });
                }
            },

            function findServersToUpdate(ctx, next) {
                steps.servers.selectServers({
                    log: opts.sdcadm.log,
                    sdcadm: sdcadm,
                    includeServerNames: self.includeServerNames,
                    excludeServerNames: self.excludeServerNames,
                    // Allow not running servers. We error on them below.
                    allowNotRunning: true,
                    serverExtras: ['agents']
                }, function selectedServers(err, servers) {
                    self.servers = servers.filter(function up2Date(srv) {
                        let agent = srv.agents.filter(function findByName(a) {
                            return (a.name === self.svcName);
                        })[0];
                        return (!agent ||
                            agent.image_uuid !== self.svcImg.uuid);
                    });

                    // If there are no running servers here, the next function
                    // will raise an exception looking at ctx.servers contents:
                    ctx.servers = self.servers;
                    next(err);
                });
            },
            steps.servers.ensureServersRunning
        ]
    }, function prepareCb(prepareErr) {
        if (prepareErr) {
            cb(prepareErr);
            return;
        }
        let nothingToDo = true;
        // Unless we hit one of these, there's no need to run the procedure's
        // execute method, and summarize should inform the user accordingly.
        if (!self.svc ||
            self.needToDownloadImg ||
            self.svc.params.image_uuid !== self.svcImg.uuid ||
            self.servers.length) {
            nothingToDo = false;
        }
        cb(null, nothingToDo);
    });
};

AddAgentServiceProcedure.prototype.summarize =
function summarize() {
    const self = this;
    // Make sure prepare run before summarize:
    assert.string(self.svcName, 'self.svcName');
    assert.object(self.svcImg, 'self.svcImg');

    let out = [];

    if (!self.svc) {
        out.push(sprintf('create "%s" service in SAPI', self.svcName));
    }

    if (self.needToDownloadImg) {
        out.push(sprintf('download image %s (%s@%s)\n' +
            '    from updates server using channel "%s"', self.svcImg.uuid,
            self.svcImg.name, self.svcImg.version, self.channel));
    }

    if (self.svc && self.svc.params.image_uuid !== self.svcImg.uuid) {
        out.push(sprintf('update service "%s" in SAPI\n' +
            '    to image %s (%s@%s)', self.svcName, self.svcImg.uuid,
            self.svcImg.name, self.svcImg.version));
    }

    if (self.servers.length) {
        out.push(sprintf('create "%s" service instance on "%d" servers',
            self.svcName, self.servers.length));
    }

    return out.join('\n');
};

AddAgentServiceProcedure.prototype.execute =
function execute(opts, cb) {
    const self = this;
    // Make sure prepare was run before execute:
    assert.object(self.svcImg, 'self.svcImg');
    assert.object(self.svcData, 'self.svcData');

    assert.object(opts, 'opts');
    assert.func(cb, 'cb');

    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');

    const sdcadm = opts.sdcadm;
    const log = opts.log;
    const ui = opts.ui;


    vasync.pipeline({
        funcs: [
            function importSvcImageIfNecessary(_, next) {
                if (!self.needToDownloadImg) {
                    next();
                    return;
                }

                ui.info('Importing image %s (%s@%s)', self.svcImg.uuid,
                    self.svcImg.name, self.svcImg.version);
                var proc = new DownloadImages({
                    images: [self.svcImg],
                    channel: self.channel
                });
                proc.execute({
                    sdcadm: sdcadm,
                    log: log,
                    ui: ui,
                    progress: ui.progressFunc()
                }, next);
            },

            function updateExistingSvc(_, next) {
                if (self.svc &&
                    self.svc.params.image_uuid !== self.svcImg.uuid) {
                    self.svc.params.image_uuid = self.svcImg.uuid;
                    ui.info('Updating "%s" SAPI service image_uuid',
                        self.svcName);
                    sdcadm.sapi.updateService(self.svc.uuid, self.svc, next);
                    return;
                }
                next();
            },

            function createSvc(_, next) {
                if (self.svc) {
                    next();
                    return;
                }

                ui.info('Creating "' + self.svcName + '" service');
                self.svcData.params.image_uuid = self.svcImg.uuid;

                sdcadm.sapi.createService(self.svcName, sdcadm.sdcApp.uuid,
                        self.svcData, function createSvcCb(err, svc) {
                    if (err) {
                        next(new SDCClientError(err, 'sapi'));
                        return;
                    }
                    self.svc = svc;
                    log.info({svc: svc}, 'created ' + self.svcName + ' svc');
                    next();
                });
            },

            function updateAgentOnServers(_, next) {
                if (!self.servers.length) {
                    next();
                    return;
                }

                var errs = [];
                var completed;

                ui.barStart({
                    name: 'Installing ' + self.svcName,
                    size: self.servers.length
                });

                // Check task completion by taskid
                function waitUntilTaskCompletes(taskid, _cb) {
                    sdcadm.cnapi.waitTask(taskid, {
                        timeout: 60 * 5000
                    }, function (err, task) {
                        log.debug({err: err, task: task}, 'cnapi.waitTask');

                        if (err) {
                            _cb(err);
                        } else {
                            if (task.status === 'failure') {
                                var msg = format('Task %s failed', taskid);
                                if (task.history[0].event.error) {
                                    msg += ' with error: ' +
                                        task.history[0].event.error.message;
                                }
                                _cb(new UpdateError(msg));
                                return;
                            }
                            _cb();
                        }
                    });
                }

                function installAgent(server, callback) {
                    log.debug({
                        server: server.uuid
                    }, 'Installing ' + self.svcName + ' instance');

                    sdcadm.cnapi.post({
                        path: format('/servers/%s/install-agent', server.uuid)
                    }, {
                        image_uuid: self.svcImg.uuid
                    }, function cnapiCb(er2, res) {
                        if (er2) {
                            callback(new SDCClientError(er2, 'cnapi'));
                            return;
                        }

                        log.debug({
                            svc: self.svcName,
                            server: server.uuid,
                            image: self.svcImg.uuid,
                            taskId: res.id
                        }, 'Waiting for install_agent task to complete');

                        waitUntilTaskCompletes(res.id, function (er3) {
                            if (er3) {
                                errs.push(er3);
                            }
                            log.debug({
                                err: er3,
                                taskId: res.id,
                                svc: self.svcName,
                                server: server.uuid
                            }, 'agent_install task completed');
                            callback();
                        });
                    });
                }

                let queue = vasync.queue(installAgent, self.concurrency);
                queue.push(self.servers, function doneOne() {
                    completed += 1;
                    ui.barAdvance(completed);
                });
                queue.close();
                queue.on('end', function queueDone() {
                    ui.barEnd();
                    if (errs.length) {
                        ui.info(
                            '"%s" install failed on %d server%s.', self.svcName,
                            errs.length, (errs.length > 1 ? 's' : ''));
                        next(new VError.errorFromList(errs));
                    } else {
                        ui.info('Successfully installed "%s" on all servers.',
                            self.svcName);
                        next();
                    }
                });
            }

        ]}, cb);
};


// --- exports

module.exports = {
    AddAgentServiceProcedure: AddAgentServiceProcedure
};

// vim: set softtabstop=4 shiftwidth=4:
