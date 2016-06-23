/**
 * @author Yikai Gong
 */

"use strict";

var pkgcloud = require("pkgcloud"), _ = require("underscore");
var async = require("async");
var Docker = require("dockerode"), querystring = require("querystring");
var utils = require("../../utils/utils");
var logUpdate = require('log-update');

var docker = {};
module.exports.docker = docker;

/**
 * Pulls the Docker images from all the nodes defined in Grunt and present in
 * the cluster
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options The task parameters
 * @param {Function} gruntDone
 *          done Callback to call when the requests are completed
 */
docker.pull = function (grunt, options, gruntDone) {
  grunt.log.ok("Started pulling images.");
  var progressLines = {};
  var progressUpdater = setInterval(function () {
    if (!_.isEmpty(progressLines))
      logUpdate(_.toArray(progressLines).join("\n"));
  }, 200);
  utils.iterateOverClusterImages(
    grunt,
    options,
    function (image, next) {
      grunt.log.ok("Started pulling image " + image.name + " on node "
        + image.node.name);

      (new Docker(image.node.docker)).pull(image.repo, image, function (err, stream) {
        if (err) {
          return next(err);
        }
        stream.setEncoding("utf8");

        stream.on("error", function (err) {
          grunt.log.error(err);
          next(err);
        });

        stream.on("data", function (data) {
          // FIXME: it looks the end of pulling JSON message arrives malformed,
          // hence this work-around is needed to complete the pulling
          grunt.verbose.ok(data);
          try {
            var jsonData = JSON.parse(data);
            if (jsonData && jsonData.error) {
              stream.emit("error", jsonData.error);
            }
            progressLines[image.node.id] = image.node.name + ": " + jsonData.status + " " + jsonData.progress;
          } catch (err) {
            // grunt.log.error("Warning pulling image: " + err.message);
          }
        });

        stream.on("end", function () {
          logUpdate.clear()
          logUpdate.done();
          grunt.log.ok("Done pulling image " + image.name + " on node "
            + image.node.name);
          next();
        });
      }, image.auth);

    }, function (err) {
      clearInterval(progressUpdater);
      if (err) {
        return gruntDone(err);
      }
      grunt.log.ok("Done pulling images.");
      return gruntDone();
    }, false);
};
docker.pull.description = "Pull images into every cluster node";

/**
 * Creates the Docker containers for all the nodes and images in the cluster
 * (during this process the cluster IP addresses are added to the /etc/hosts of
 * every node)
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options The task parameters
 * @param {Function} done
 *          done Callback to call when the requests are completed
 */
docker.run = function (grunt, options, done) {

  var hosts = [];

  /*
   * Function to create and run a container from image
   */
  var runIterator = function (image, next) {

    if (!utils.isContainerToBeProcessed(grunt, image.node.type,
        image.node.id, image.name, null)) {
      return next();
    }

    grunt.log.ok("Started creating and running the container from "
      + image.name + " on node " + image.node.name);

    // Adds the nodes addresses the the start options
    var createOptions = _.clone(image.options.run.create);
    createOptions.HostConfig = (createOptions.HostConfig) ? createOptions.HostConfig
      : {};

    // If the newtwork mode is not "host", adds all the hosts, and the current
    // node address as Hostname and "dockerhost"
    if (!createOptions.HostConfig.NetworkMode
      || createOptions.HostConfig.NetworkMode.toLowerCase() !== "host") {
      createOptions.HostConfig.ExtraHosts = hosts.concat("dockerhost" + ":"
        + image.node.ipv4);
      if (createOptions.Hostname) {
        createOptions.HostConfig.ExtraHosts.push(createOptions.Hostname + ":"
          + image.node.ipv4);
      }
    }

    // Adds host alias defined (in the Gruntfile), an array of: <host
    // name>:<alias>
    if (createOptions["clouddity:HostAliases"]) {
      createOptions["clouddity:HostAliases"]
        .forEach(function (alias) {
          var aliasHost = _.find(hosts, function (host) {
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

    var cluster_env = "CLUSTER_NODES_LIST=" + hosts.join(',');
    createOptions.Env = createOptions.Env
      ? createOptions.Env.concat(cluster_env)
      : [cluster_env];
    var streamo = (new Docker(image.node.docker)).run(image.repo,
      image.options.run.cmd, null, createOptions, image.options.run.start,
      function (err, data, container) {
        utils.handleErr(err, function (err) {
        }, true);
      });

    streamo.on("error", function (err) {
      grunt.verbose.error(err);
      next(err);
    });

    streamo.on("stream", function (stream) {
      stream.on("data", function (chunk) {
        grunt.verbose.ok(chunk);
      })
    });

    streamo.on("container", function (container) {
      // NOTE: The start of a container that should be started already is a
      // cautionary measure to avoid this Docker Remote API bug
      // https://github.com/logstash-plugins/logstash-output-elasticsearch/issues/273
      (new Docker(image.node.docker)).getContainer(container.id).start(
        {},
        function (err, data) {
          // This error is ignored, since it will raised in the vast majority
          // of cases, since the container has started already
          utils.handleErr(err, function (err) {
          }, true);
          grunt.log.ok("Completed creating and running the container "
            + container.id + " from image " + image.name + " on node "
            + image.node.name);
          streamo.emit("end");
        });
    });

    streamo.on("end", function () {
      next();
    });

  };

  // Puts in optServers the nodes names and IP addresses, then executes
  // runIteraotr on them
  grunt.log.ok("Started creating containers.");

  utils.iterateOverClusterNodes(
    options,
    "ACTIVE",
    function (node, callback) {
      hosts.push(node.name + ":" + node.ipv4);
      return callback();
    },
    function (err) {
      if (err)
        return utils.handleErr(err, done, false);
      hosts.sort();
      utils.iterateOverClusterImages(
        grunt,
        options,
        runIterator,
        function (err) {
          utils.handleErr(err, function (err) {
          });
          grunt.log.ok("Done creating containers.");
          done();
        },
        false
      );
    },
    true
  );
};
docker.run.description = "Run images on cluster every node";

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
docker.ps = function (grunt, options, gruntDone) {
  /*
   * Function to prints information on a container
   */
  var listIterator = function (container, next) {
    grunt.log.ok([container.node.name, container.node.address,
      container.container.Image, container.container.Status,
      container.container.Id].join(","));
    next();
  };

  grunt.log.ok("nodename,address,image,status,containerid");

  utils.iterateOverClusterContainers(grunt, options, listIterator,
    function (err) {
      if (err) {
        return gruntDone(err);
      }
      gruntDone();
    }
  );
};
docker.ps.description = "List docker containers on every cluster node";

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
docker.start = function (grunt, options, gruntDone) {
  docker.start.description = "Start all containers on every cluster node";

  /*
   * Function to start a container
   */
  var startIterator = function (container, next) {

    if (!utils.isContainerToBeProcessed(grunt, container.node.type,
        container.node.id, container.container.Image.match(/\/(.+)\:/)[1],
        container.container.Id)) {
      return next();
    }
    var containerId = container.container.Id;
    var containerName = container.container.Names[0];
    var containerImage = container.container.Image;
    grunt.log.ok("Started starting container " + containerId + containerName
      + "  on node " + container.node.name);
    (new Docker(container.node.docker)).getContainer(container.container.Id)
      .start({}, function (err, data) {
        utils.handleErr(err, function (err) {
        }, true);
        next();
      });
  };

  grunt.log.ok("Started starting containers");

  utils.iterateOverClusterContainers(grunt, options, startIterator, function (err) {
    utils.handleErr(err, function (err) {
    }, true);
    grunt.log.ok("Completed starting containers");
    gruntDone();
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
docker.stop = function (grunt, options, gruntDone) {

  /*
   * Function to stop a container
   */
  var stopIterator = function (container, next) {

    if (!utils.isContainerToBeProcessed(grunt, container.node.type,
        container.node.id, container.container.Image.match(/\/(.+)\:/)[1],
        container.container.Id)) {
      return next();
    }
    var containerId = container.container.Id;
    var containerName = container.container.Names[0];
    var containerImage = container.container.Image;

    grunt.log.ok("Started stopping container " + containerId + containerName
      + "  on node " + container.node.name);
    (new Docker(container.node.docker)).getContainer(container.container.Id)
      .stop({}, function (err, data) {
        if (err) {
          return utils.handleErr(err, next, true);
        } else {
          return next();
        }
      });
  };

  grunt.log.ok("Started stopping containers");

  utils.iterateOverClusterContainers(grunt, options, stopIterator,
    function (err) {
      utils.handleErr(err, function (err) {
      }, false);
      grunt.log.ok("Completed stopping containers");
      gruntDone();
    });

};
docker.stop.description = "Stop all containers on every node";

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
docker.rm = function (grunt, options, gruntDone) {

  /*
   * Function to remove a container
   */
  var removeIterator = function (container, next) {
    if (!utils.isContainerToBeProcessed(grunt, container.node.type,
        container.node.id, container.container.Image.match(/\/(.+)\:/)[1],
        container.container.Id)) {
      return next();
    }

    grunt.log.ok("Started removing container " + container.container.Id
      + "  on node " + container.node.address);
    (new Docker(container.node.docker)).getContainer(container.container.Id)
      .remove({}, function (err, data) {
        utils.handleErr(err, function (err) {
        }, true);
        next();
      });
  };

  grunt.log.ok("Started removing containers");

  utils.iterateOverClusterContainers(grunt, options, removeIterator, function (err) {
    utils.handleErr(err, function (err) {
    }, false);
    grunt.log.ok("Completed removing containers");
    gruntDone();
  });

};
docker.rm.description = "Remove all containers on every cluster node";

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
docker.rmi = function (grunt, options, gruntDone) {

  /*
   * Function to remove a image
   */
  var removeIterator = function (image, next) {

    grunt.log.ok("Started removing image " + image.image.Id
      + "  on node " + image.node.ipv4);
    (new Docker(image.node.docker)).getImage(image.image.Id)
      .remove({}, function (err, data) {
        utils.handleErr(err, function (err) {
        }, true);
        next();
      });
  };

  grunt.log.ok("Started removing images");

  utils.iterateOverClusterDockerImages(grunt, options, removeIterator, function (err) {
    utils.handleErr(err, function (err) {
    });
    grunt.log.ok("Completed removing images");
    return gruntDone();
  });
};
docker.rmi.description = "Remove all images on every cluster node";

docker.images = function (grunt, options, gruntDone) {
  var images = {};  // {nodeId}
  var nodeIterator = function (node, next) {
    grunt.log.ok(node.name + " " + node.address + ":");
    (new Docker(node.docker)).listImages(null, function (err, imageList) {
      if (err)
        return utils.handleErr(err, next, true);
      if (imageList.length > 0) {
        imageList.forEach(function (image) {
          grunt.log.ok(image.RepoTags[0] + " Built on " + new Date(image.Created));
        })
      }
      grunt.log.ok(" ");
      return next();
    })
  };
  var iteratorStopped = function (err) {
    gruntDone();
  };
  utils.iterateOverClusterNodes(options, "ACTIVE", nodeIterator, iteratorStopped, true);
}
docker.images.description = "List all images on every cluster node";

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
docker.test = function (grunt, options, done) {

  grunt.log.ok("Started testing containers...");

  /*
   * Executes all the tests defined in the test property of
   */
  var testIterator = function (node, nextNode) {

    node.test = _.find(options.nodetypes, function (nodetype) {
      return nodetype.name === node.type
    }).test;

    // If no tests are defined, skips
    if (!node.test || node.test.length < 1) {
      return nextNode();
    }

    grunt.log.ok("Started testing " + node.name);

    async.eachSeries(node.test, function (testcase, nextTestCase) {

      var http = (testcase.protocol === "http") ? require("http")
        : require("https");
      var auth = (testcase.auth) ? testcase.auth.username + ":"
      + testcase.auth.password : null;

      http.get(
        {
          host: node.ipv4,
          auth: auth,
          port: testcase.port,
          path: testcase.path
          + (testcase.query ? "?" + querystring.stringify(testcase.query)
            : null)
        },
        function (res) {
          var body = "";
          res.on("data", function (data) {
            grunt.verbose.ok(data);
            body += data;
          });
          res.on("error", function (err) {
            grunt.log.error("Test " + testcase.name + " in error");
            grunt.log.error(err);
            nextTestCase();
          });
          res.on("end", function () {
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
        }).on("error", function (err) {
        grunt.log.error("Test " + testcase.name + " in error");
        grunt.log.error(err);
        nextTestCase();
      });
    }, function (err) {
      nextNode(err);
    });
  };

  // Tests all the containers for all the servers defined in options and present
  // in the cluster
  utils.iterateOverClusterNodes(
    options,
    "ACTIVE",
    testIterator,
    function (err) {
      utils.handleErr(err, function (err) {
      }, true);
      grunt.log.ok("Completed testing");
      done();
    },
    true
  );
};
docker.test.description = "Test if containers on cluster nodes runs correctly";