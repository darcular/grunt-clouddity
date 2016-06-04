/**
 * Task functions to manage Docker
 *
 * @author Yikai Gong
 */

"use strict";

var pkgcloud = require("pkgcloud"), _ = require("underscore"), grunt = require("grunt");
var async = require("async");
var Docker = require("dockerode"), querystring = require("querystring");
var utils = require("../utils/utils");

/**
 * Pulls the Docker images from all the nodes defined in Grunt and present in
 * the cluster
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.pull = function(grunt, options, done) {

    grunt.log.ok("Started pulling images.");

    utils.iterateOverClusterImages(grunt, options, function(image, next) {

        grunt.log.ok("Started pulling image " + image.name + " on node "
            + image.node.node.name);

        (new Docker(image.node.docker)).pull(image.repo, image, function(err,
                                                                         stream) {
            if (err) {
                return next(err);
            }

            stream.setEncoding("utf8");

            stream.on("error", function(err) {
                grunt.log.error(err);
                next(err);
            });

            stream.on("data", function(data) {
                // FIXME: it looks the end of pulling JSON message arrives malformed,
                // hence this work-around is needed to complete the pulling
                grunt.verbose.ok(data);
                try {
                    var jsonData = JSON.parse(data);
                    if (jsonData && jsonData.error) {
                        stream.emit("error", jsonData.error);
                    }
                } catch (err) {
                    grunt.log.error("Warning pulling image: " + err.message);
                }
            });

            stream.on("end", function() {
                grunt.log.ok("Done pulling image " + image.name + " on node "
                    + image.node.node.name);
                next();
            });
        }, image.auth);

    }, function(err) {
        if (err) {
            return done(err);
        }
        grunt.log.ok("Done pulling images.");
        done();
    }, false);
};

/**
 * Creates the Docker containers for all the nodes and images in the cluster
 * (during this process the cluster IP addresses are added to the /etc/hosts of
 * every node)
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.run = function(grunt, options, done) {

    var hosts = [];

    /*
     * Function to create and run a container from image
     */
    var runIterator = function(image, next) {

        if (!utils.isContainerToBeProcessed(grunt, image.node.node.type,
                image.node.node.id, image.name, null)) {
            return next();
        }

        grunt.log.ok("Started creating and running the container from "
            + image.name + " on node " + image.node.node.name);

        // Adds the nodes addresses the the start options
        var createOptions = _.clone(image.options.run.create);
        createOptions.HostConfig = (createOptions.HostConfig) ? createOptions.HostConfig
            : {};

        // If the newtwork mode is not "host", adds all the hosts, and the current
        // node address as Hostname and "dockerhost"
        if (!createOptions.HostConfig.NetworkMode
            || createOptions.HostConfig.NetworkMode.toLowerCase() !== "host") {
            createOptions.HostConfig.ExtraHosts = hosts.concat("dockerhost" + ":"
                + image.node.node.address);
            if (createOptions.Hostname) {
                createOptions.HostConfig.ExtraHosts.push(createOptions.Hostname + ":"
                    + image.node.node.address);
            }
        }

        // Adds host alias defined (in the Gruntfile), an array of: <host
        // name>:<alias>
        if (createOptions["clouddity:HostAliases"]) {
            createOptions["clouddity:HostAliases"]
                .forEach(function(alias) {
                    var aliasHost = _.find(hosts, function(host) {
                        return host.split(":")[0] === alias.split(":")[0];
                    });

                    if (!aliasHost) {
                        grunt.log
                            .error("Host "
                                + alias
                                + " referenced in HostAliases does not seem to exist in the cluster");
                        return;
                    }

                    createOptions.HostConfig.ExtraHosts.push(alias.split(":")[1] + ":"
                        + aliasHost.split(":")[1]);
                });
        }

        // FIXME: the current host's image name should be deleted from ExtraHosts
        // ["scats-1-master:115.146.95.194","scats-1-slave:115.146.95.192","dockerhost:115.146.95.192","sparkslave:115.146.95.192","sparkmaster:115.146.95.194"]
        // ["scats-1-master:115.146.95.194","scats-1-slave:115.146.95.192","dockerhost:115.146.95.194","sparkmaster:115.146.95.194"]

        var streamo = (new Docker(image.node.docker)).run(image.repo,
            image.options.run.cmd, null, createOptions, image.options.run.start,
            function(err, data, container) {
                utils.dealWithError(err, function(err) {
                });
            });

        streamo.on("error", function(err) {
            grunt.verbose.error(err);
            next(err);
        });

        streamo.on("stream", function(stream) {
            stream.on("data", function(chunk) {
                grunt.verbose.ok(chunk);
            })
        });

        streamo.on("container", function(container) {
            // NOTE: The start of a container that should be started already is a
            // cautionary measure to avoid this Docker Remote API bug
            // https://github.com/logstash-plugins/logstash-output-elasticsearch/issues/273
            (new Docker(image.node.docker)).getContainer(container.id).start(
                {},
                function(err, data) {
                    // This error is ignored, since it will raised in the vast majority
                    // of cases, since the container has started already
                    utils.dealWithError(err, function(err) {
                    });
                    grunt.log.ok("Completed creating and running the container "
                        + container.id + " from image " + image.name + " on node "
                        + image.node.node.name);
                    streamo.emit("end");
                });
        });

        streamo.on("end", function() {
            next();
        });

    };

    // Puts in optServers the nodes names and IP addresses, then executes
    // runIteraotr on them
    grunt.log.ok("Started creating containers.");

    utils.iterateOverClusterNodes(options, function(node, callback) {
        hosts.push(node.node.name + ":" + node.node.address);
        return callback();
    }, function(err) {
        utils.dealWithError(err, done);
        utils.iterateOverClusterImages(grunt, options, runIterator, function(err) {
            utils.dealWithError(err, function(err) {
            });
            grunt.log.ok("Done creating containers.");
            done();
        });
    });

};

/**
 * List all active Docker containers in the cluster.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.listcontainers = function(grunt, options, done) {

    /*
     * Function to prints information on a container
     */
    var listIterator = function(container, next) {
        grunt.log.ok([ container.node.node.name, container.node.node.address,
            container.container.Image, container.container.Status,
            container.container.Id ].join(","));
        next();
    };

    grunt.log.ok("nodename,address,image,status,containerid");

    utils.iterateOverClusterContainers(grunt, options, listIterator,
        function(err) {
            if (err) {
                return done(err);
            }
            done();
        });

};

/**
 * Starts all Docker containers in the cluster.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.start = function(grunt, options, done) {

    /*
     * Function to start a container
     */
    var startIterator = function(container, next) {

        if (!utils.isContainerToBeProcessed(grunt, container.node.node.type,
                container.node.node.id, container.container.Image.match(/\/(.+)\:/)[1],
                container.container.Id)) {
            return next();
        }

        grunt.log.ok("Started starting container " + container.container.Id
            + "  on node " + container.node.node.address);
        (new Docker(container.node.docker)).getContainer(container.container.Id)
            .start({}, function(err, data) {
                utils.dealWithError(err, function(err) {
                });
                next();
            });
    };

    grunt.log.ok("Started starting containers");

    utils.iterateOverClusterContainers(grunt, options, startIterator, function(
        err) {
        utils.dealWithError(err, function(err) {
        });
        grunt.log.ok("Completed starting containers");
        done();
    });

};

/**
 * Stops all Docker containers in the cluster.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.stop = function(grunt, options, done) {

    /*
     * Function to stop a container
     */
    var stopIterator = function(container, next) {

        if (!utils.isContainerToBeProcessed(grunt, container.node.node.type,
                container.node.node.id, container.container.Image.match(/\/(.+)\:/)[1],
                container.container.Id)) {
            return next();
        }

        grunt.log.ok("Started stopping container " + container.container.Id
            + "  on node " + container.node.node.address);
        (new Docker(container.node.docker)).getContainer(container.container.Id)
            .stop({}, function(err, data) {
                utils.dealWithError(err, function(err) {
                });
                next();
            });
    };

    grunt.log.ok("Started stopping containers");

    utils.iterateOverClusterContainers(grunt, options, stopIterator,
        function(err) {
            utils.dealWithError(err, function(err) {
            });
            grunt.log.ok("Completed stopping containers");
            done();
        });

};

/**
 * Removes all Docker containers in the cluster.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.remove = function(grunt, options, done) {

    /*
     * Function to remove a container
     */
    var removeIterator = function(container, next) {
        if (!utils.isContainerToBeProcessed(grunt, container.node.node.type,
                container.node.node.id, container.container.Image.match(/\/(.+)\:/)[1],
                container.container.Id)) {
            return next();
        }

        grunt.log.ok("Started removing container " + container.container.Id
            + "  on node " + container.node.node.address);
        (new Docker(container.node.docker)).getContainer(container.container.Id)
            .remove({}, function(err, data) {
                utils.dealWithError(err, function(err) {
                });
                next();
            });
    };

    grunt.log.ok("Started removing containers");

    utils.iterateOverClusterContainers(grunt, options, removeIterator, function(
        err) {
        utils.dealWithError(err, function(err) {
        });
        grunt.log.ok("Completed removing containers");
        done();
    });

};

/**
 * Removes all Docker images in the cluster.
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.removeImg = function(grunt, options, done) {

    /*
     * Function to remove a image
     */
    var removeIterator = function(image, next) {
        // if (!utils.isContainerToBeProcessed(grunt, container.node.node.type,
        //     container.node.node.id, container.container.Image.match(/\/(.+)\:/)[1],
        //     container.container.Id)) {
        //   return next();
        // }

        grunt.log.ok("Started removing image " + image.image.Id
            + "  on node " + image.node.node.address);
        (new Docker(image.node.docker)).getImage(image.image.Id)
            .remove({}, function(err, data) {
                utils.dealWithError(err, function(err) {
                });
                next();
            });
    };

    grunt.log.ok("Started removing images");

    utils.iterateOverClusterDockerImages(grunt, options, removeIterator, function(
        err) {
        utils.dealWithError(err, function(err) {
        });
        grunt.log.ok("Completed removing images");
        done();
    });
};

/**
 * Tests all the Docker containers in the cluster
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.test = function(grunt, options, done) {

    grunt.log.ok("Started testing containers...");

    /*
     * Executes all the tests defined in the test property of
     */
    var testIterator = function(node, nextNode) {

        node.test = _.find(options.nodetypes, function(nodetype) {
            return nodetype.name === node.node.type
        }).test;

        // If no tests are defined, skips
        if (!node.test || node.test.length < 1) {
            return nextNode();
        }

        grunt.log.ok("Started testing " + node.node.name);

        async.eachSeries(node.test, function(testcase, nextTestCase) {

            var http = (testcase.protocol === "http") ? require("http")
                : require("https");
            var auth = (testcase.auth) ? testcase.auth.username + ":"
            + testcase.auth.password : null;

            http.get(
                {
                    host : node.node.address,
                    auth : auth,
                    port : testcase.port,
                    path : testcase.path
                    + (testcase.query ? "?" + querystring.stringify(testcase.query)
                        : null)
                },
                function(res) {
                    var body = "";
                    res.on("data", function(data) {
                        grunt.verbose.ok(data);
                        body += data;
                    });
                    res.on("error", function(err) {
                        grunt.log.error("Test " + testcase.name + " in error");
                        grunt.log.error(err);
                        nextTestCase();
                    });
                    res.on("end", function() {
                        if (body.indexOf(testcase.shouldStartWith) === 0) {
                            grunt.log.ok("Test " + testcase.name
                                + " successfully completed");
                        } else {
                            if (body.indexOf(testcase.shouldContain) >= 0) {
                                grunt.log.ok("Test " + testcase.name
                                    + " successfully completed");
                            } else {
                                grunt.log.error("Test " + testcase.name + " in error");
                            }
                        }

                        nextTestCase();
                    });
                }).on("error", function(err) {
                grunt.log.error("Test " + testcase.name + " in error");
                grunt.log.error(err);
                nextTestCase();
            });
        }, function(err) {
            nextNode(err);
        });
    };

    // Tests all the containers for all the servers defined in options and present
    // in the cluster
    utils.iterateOverClusterNodes(options, testIterator, function(err) {
        utils.dealWithError(err, function(err) {
        });
        grunt.log.ok("Completed testing");
        done();
    });
};