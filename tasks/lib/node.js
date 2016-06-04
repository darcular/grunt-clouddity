/**
 * Task functions to manage host node
 *
 * @author Yikai Gong
 */

"use strict";

var pkgcloud = require("pkgcloud"), _ = require("underscore"), grunt = require("grunt");
var async = require("async"), exec = require("child_process").exec;
var querystring = require("querystring");
var utils = require("../utils/utils");

/**
 * List all the nodes in the cluster
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.listnodes = function(grunt, options, done) {

    if (!grunt.option("hosts-format")) {
        grunt.log.ok("name,id,address,images...");
    }

    utils.iterateOverClusterNodes(options, function(node, next) {
        if (!grunt.option("hosts-format")) {
            grunt.log.ok([ node.node.name, node.node.id, node.node.address,
                _.pluck(node.images, "name") ].join(","));
        } else {
            console.log([ node.node.address, node.node.name ].join(" "));
        }
        return next();
    }, function(err) {
        utils.dealWithError(err, function(err) {
        });
        done();
    });
};

/**
 * Creates the VMs that are defined in options.nodetypes
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.createnodes = function(grunt, options, done) {

    grunt.log.ok("Started creating nodes...");

    async.each(utils.getDefinedNodes(options), function(node, callback) {

        pkgcloud.compute.createClient(options.pkgcloud.client).createServer(
            {
                tenantId : options.pkgcloud.client.tenantName,
                security_groups : utils.securityGroupsAsOpenstack(options.cluster,
                    node.securitygroups),
                user_data : options.pkgcloud.user_data,
                availability_zone : options.pkgcloud.availability_zone,
                imageRef : node.imageRef,
                flavorRef : node.flavorRef,
                name : node.name,
                key_name : options.pkgcloud.key_name
            }, function(err, result) {
                utils.dealWithError(err, callback);
                if (!err) {
                    grunt.log.ok("Created node: " + result.name + " " + result.id);
                    return callback(err);
                }
            });
    }, function(err) {
        grunt.log.ok("Done creating nodes.");
        if (err) {
            return done(err);
        }
        done();
    });
};

/**
 * Deletes the VMs that are defined in options.serverstypes. The servers to be
 * deleted are found by their names (a compistion of servertypes.name, an hypen,
 * and a progressive number.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options Task options
 * @param {Function}
 *          done Callback to call when the request is completed
 */
module.exports.destroynodes = function(grunt, options, done) {

    grunt.log.ok("Started deleting nodes...");

    utils.iterateOverClusterNodes(options, function(node, callback) {
        pkgcloud.compute.createClient(options.pkgcloud.client).destroyServer(
            node.node.id, function(err, result) {
                utils.dealWithError(err, callback);
                if (!err) {
                    grunt.log.ok("Deleted node: " + result.ok);
                    return callback(err);
                }
            });
    }, function(err) {
        grunt.log.ok("Done deleting nodes.");
        if (err) {
            return done(err);
        }
        done();
    });
};

/**
 * Copy data from the client machines to the nodes volumes using the scp
 * command. NOTE: it has to run after the nodes have been created
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.copytohost = function(grunt, options, done) {

    /*
     * Copies data to the node machine
     */
    var copyIterator = function(node, nextNode) {
        node.copytohost = _.find(options.nodetypes, function(nodetype) {
            return nodetype.name === node.node.type
        }).copytohost;

        // If no volumes are defined, skips
        if (!node.copytohost || node.copytohost.length === 0) {
            return nextNode();
        }

        grunt.log.ok("Started copying volume on node " + node.node.name);

        async.eachSeries(node.copytohost,
            function(volume, nextVolume) {

                var recursiveOption = require("fs").lstatSync(volume.from)
                    .isDirectory() ? "-r" : "";
                exec("scp " + recursiveOption + " -o StrictHostKeyChecking=no -i "
                    + options.ssh.privateKeyFile + " " + volume.from + " "
                    + options.ssh.username + "@" + node.node.address + ":"
                    + volume.to, function(err, stdout, stderr) {
                    nextVolume(err);
                });
            }, function(err) {
                nextNode(err);
            });
    };

    // Copies data as defined in options and present in the cluster
    utils.iterateOverClusterNodes(options, copyIterator, function(err) {
        utils.dealWithError(err, done);
        grunt.log.ok("Completed copying volumes");
        done();
    });
};


/**
 * Add all hosts in the cluster to the /etc/hosts of every node
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.addhosts = function(grunt, options, done) {

    var hosts = [];
    var username = options.pkgcloud.client.sshusername;
    var sshExec = function(address, cmd, callback) {
        exec([ "ssh", username + "@" + address, "-C" ].concat(cmd).join(" "),
            callback);
    };

    grunt.log.ok("Started changing hosts file...");

    // Puts in host the nodes names and IP addresses
    utils.iterateOverClusterNodes(options, function(node, nextNode) {
        hosts.push(node.node.address + " " + node.node.name);
        return nextNode();
    }, function(err) {
        utils.dealWithError(err, done);

        // Adds hosts to the /etc/hosts of every node
        utils.iterateOverClusterNodes(options, function(node, next) {

            sshExec(node.node.address, "'echo \"" + hosts.join("\n")
                + "\" > /tmp/hosts && cat /etc/hosts >> /tmp/hosts'", function(err,
                                                                               stdout, stderr) {
                sshExec(node.node.address, "'sudo cp /tmp/hosts /etc/hosts'", function(
                    err, stdout, stderr) {
                    utils.dealWithError(err, function(err) {
                    });
                    grunt.log.ok("Done appending hosts to " + node.node.name);
                    next();
                });

            });
        }, function(err) {
            utils.dealWithError(err, function(err) {
            });
            grunt.log.ok("Done appending hosts");
            done();
        });
    });

};