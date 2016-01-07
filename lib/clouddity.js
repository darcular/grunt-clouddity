/**
 * Utility functions operating to iterate over nodes and images
 */

"use strict";

var pkgcloud = require("pkgcloud"), _ = require("underscore"), grunt = require("grunt");
var async = require("async"), exec = require("child_process").exec, utils = require("../lib/utils");
var Docker = require("dockerode");

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

  grunt.log.ok("name,id,address,images...");

  utils.iterateOverClusterNodes(options, function(node, callback) {
    grunt.log.ok([ node.node.name, node.node.id, node.node.address,
        _.pluck(node.images, "name") ].join(","));
    return callback();
  }, function(err) {
    if (err) {
      return done(err);
    }
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
 * List all the security groups in the cluster
 * 
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.listsecuritygroups = function(grunt, options, done) {

  grunt.log.ok("name,id,rules...");

  utils.iterateOverClusterSecurityGroups(options, function(grp, callback) {
    grunt.log.ok([
        grp.name,
        grp.id,
        _.map(grp.securityGroupRules, function(rule) {
          return "{"
              + [ rule.protocol, rule.direction, rule.ethertype,
                  rule.port_range_min, rule.port_range_max,
                  rule.remote_ip_prefix ].join(",") + "}";
        }) ].join(","));
    return callback();
  }, function(err) {
    if (err) {
      return done(err);
    }
    done();
  });
};

/**
 * Adds the security groups that are defined in options
 * 
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the request is completed
 */
module.exports.createsecuritygroups = function(grunt, options, done) {

  grunt.log.ok("Started creating security groups...");

  // Iterates over the security groups in options and adds them
  var createdGroups = [];
  async.each(_.keys(options.securitygroups), function(grpName, callback) {
    pkgcloud.network.createClient(options.pkgcloud.client).createSecurityGroup(
        {
          name : utils.securitygroupName(options.cluster, grpName),
          description : options.securitygroups[grpName].description
        },
        function(err, result) {
          utils.dealWithError(err, done);
          if (!err) {
            createdGroups.push({
              id : result.id,
              name : grpName
            });
            grunt.log.ok("Created security group: "
                + utils.securitygroupName(options.cluster, grpName) + " "
                + result.id);
            return callback(err);
          }
        });
  }, function(err) {
    grunt.log.ok("Done creating security groups.");
    if (err) {
      return done(err);
    }
    done();
  });
};

/**
 * Deletes all the security groups in the cluster
 * 
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the requests are completed
 */
module.exports.destroysecuritygroups = function(grunt, options, done) {

  grunt.log.ok("Started deleting security groups...");

  utils.iterateOverClusterSecurityGroups(options, function(grp, callback) {
    pkgcloud.network.createClient(options.pkgcloud.client)
        .destroySecurityGroup(
            grp.id,
            function(err, result) {
              utils.dealWithError(err, done);
              if (!err) {
                grunt.log.ok("Deleted security group: " + grp.name + " "
                    + grp.id + " ");
                return callback(err);
              }
            });
  }, function(err) {
    grunt.log.ok("Done deleting security groups.");
    if (err) {
      return done(err);
    }
    done();
  });
};

/**
 * Updates the security groups that are defined in options.securitygroups with
 * the server IP addresses that are defined in options.servers
 * 
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options The task parameters
 * @param {Function}
 *          done Callback to call when the request is completed
 */
module.exports.updatesecuritygroups = function(grunt, options, done) {

  grunt.log.ok("Started updating security groups...");

  var nodes = [];

  // Retrieves the nodes data and puts them in nodes
  utils.iterateOverClusterNodes(options, function(node, callback) {
    nodes.push({
      name : node.node.name,
      id : node.node.id,
      address : node.node.address
    });
    return callback();
  }, function(err) {
    if (err) {
      return done(err);
    }

    // Updates security groups by adding the actual rules
    utils.iterateOverClusterSecurityGroups(options, function(grp, callback2) {

      // Puts in selRules all the rules of the existing group
      // that have a remoteIpPrefixTemplate or a remoteIpPrefix
      // property defined
      var rulesToAdd = [];
      var selRules = _.filter(options.securitygroups[utils
          .securitygroupPlainName(grp.name)].rules, function(rule) {
        return rule.remoteIpNodePrefixes || rule.remoteIpPrefix;
      });

      // Adds rules to rulesToAdd based on node IP addresses (if
      // remoteIpNodePrefixes), and/or remoteIpPrefix
      selRules.forEach(function(rule) {

        if (rule.remoteIpNodePrefixes) {
          nodes
              .forEach(function(node) {
                if (rule.remoteIpNodePrefixes
                    .indexOf(utils.nodeType(node.name)) >= 0) {
                  rulesToAdd.push({
                    securityGroupId : grp.id,
                    direction : rule.direction,
                    ethertype : rule.ethertype,
                    portRangeMin : rule.portRangeMin,
                    portRangeMax : rule.portRangeMax,
                    protocol : rule.protocol,
                    remoteIpPrefix : node.address
                  });
                }
              });
        }

        if (rule.remoteIpPrefix) {
          rulesToAdd.push({
            securityGroupId : grp.id,
            direction : rule.direction,
            ethertype : rule.ethertype,
            portRangeMin : rule.portRangeMin,
            portRangeMax : rule.portRangeMax,
            protocol : rule.protocol,
            remoteIpPrefix : rule.remoteIpPrefix
          });
        }
      });

      // Iterates over rulesToAdd and adds them rules
      async.each(rulesToAdd, function(rule, callback3) {
        pkgcloud.network.createClient(options.pkgcloud.client)
            .createSecurityGroupRule(rule, function(err, result) {
              utils.dealWithError(err, done);
              return callback3();
            }, function(err) {
              utils.dealWithError(err, done);
              grunt.log.ok("Updated security group: " + grp.id);
            });
      }, function(err) {
        utils.dealWithError(err, done);
        grunt.log.ok("Updated security group: " + grp.id);
        return callback2();
      });
    }, function(err) {
      if (err) {
        return done(err);
      }

      done();
    });
  });
};

/**
 * Pulls the Docker images from a registry for all the servers the servers
 * defined in Grunt and present in the cluster
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
        return next();
      });

      stream.on("data", function(data) {
        // FIXME: it looks the end of pulling JSON message arrives malformed,
        // hence this work-around is needed to complete the pulling
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
        return next();
      });
    }, image.auth);

  }, function(err) {
    if (err) {
      return done(err);
    }
    grunt.log.ok("Done pulling images.");
    done();
  });
};
