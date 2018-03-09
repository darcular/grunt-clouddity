/**
 * @author Yikai Gong
 */
var _ = require('underscore'), async = require("async");
var exec = require('child_process').exec, pkgcloud = require("pkgcloud");
var logUpdate = require('log-update');
var utils = require("../../utils/utils");

var node = {};
module.exports.node = node;

node.create = function (grunt, options, gruntDone) {
  grunt.log.ok("Started creating node...");
  var client = pkgcloud.compute.createClient(options.pkgcloud.client);
  var nodes = {};
  var tableUpdater = setInterval(function () {
    logUpdate(composeNodesTable(nodes));
  }, 1000);
  var iterator = function (node, iterationDone) {
    var serverConfig = {
      tenantId: options.pkgcloud.client.tenantName,
      securityGroups: utils.composeClusterSecGrpNameList(options.cluster, node.securitygroups),
      cloudConfig: options.pkgcloud.user_data,
      availability_zone: options.pkgcloud.availability_zone,
      image: node.imageRef,
      flavor: node.flavorRef,
      name: node.name,
      keyname: options.pkgcloud.key_name
    };
    client.createServer(serverConfig, function (err, result) {
      if (err)
        return utils.handleErr(err, iterationDone, false);
      var created = false;
      var updateTuple = function (callback) {
        utils.queryNode(options, result.id, function (err, node) {
          if (err) {
            return utils.handleErr(err, iterationDone, true);
          }
          var nodeTuple = {};
          nodeTuple.hostId = node.id.substr(0, 5) + "..";
          nodeTuple.hostName = node.name;
          nodeTuple.hostAddress = node.address;
          var hostStatus = node.status.toUpperCase();
          nodeTuple.hostStatus = changeStatusColor(hostStatus);
          nodes[nodeTuple.hostId] = nodeTuple;
          if (hostStatus == "RUNNING") {
            created = true;
          } else {
            created = false;
          }
          return callback();
        });
      };
      async.until(
        function () {
          return created
        },
        function (callback) {
          setTimeout(function () {
            return updateTuple(callback);
          }, 3000)
        },
        function (err) {
          return err ?
            utils.handleErr(err, iterationDone, false) :
            iterationDone();
        }
      );
    });
  };
  var iteratorStopped = function (err) {
    clearInterval(tableUpdater);
    logUpdate(composeNodesTable(nodes));
    logUpdate.done();
    if (err)
      return utils.handleErr(err, gruntDone, false);
    grunt.log.ok("Done creating nodes.");
    return gruntDone();
  };
  async.each(utils.getDefinedNodes(options), iterator, iteratorStopped);
};
node.create.description = "Create node VMs of cluster";

/**
 * List all the nodes in the cluster
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options The task parameters
 * @param {Function} gruntDone
 *          done Callback to call when the requests are completed
 */
node.list = function (grunt, options, gruntDone) {
  var nodes = {};
  var iterator = function (node, iterationDone) {
    var nodeTuple = {};
    nodeTuple.hostId = node.id.substr(0, 5) + "..";
    nodeTuple.hostName = node.name;
    nodeTuple.hostAddress = node.address;
    var hostStatus = node.status.toUpperCase();
    nodeTuple.hostStatus = changeStatusColor(hostStatus);
    nodes[nodeTuple.hostId] = nodeTuple;
    return iterationDone();
  };
  var iteratorStopped = function (err) {
    if (err)
      return utils.handleErr(err, gruntDone, false);
    console.log(composeNodesTable(nodes));
    return gruntDone();
  };
  utils.iterateOverClusterNodes(options, "", iterator, iteratorStopped, true);
};
node.list.description = "List nodes of cluster";

/**
 * Deletes the VMs that are defined in options.serverstypes. The servers to be
 * deleted are found by their names (a compistion of servertypes.name, an hypen,
 * and a progressive number.
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options Task options
 * @param {Function} gruntDone
 *          done Callback to call when the request is completed
 */
node.destroy = function (grunt, options, gruntDone) {
  async.waterfall([
    // First: Get user confirm
    function (next) {
      promptBeforeDestroy(function (comfirmed) {
        return next(null, comfirmed);
      });
    },
    // Second: delete nodes based on user's confirm
    function (confirm, next) {
      if (!confirm) {
        return next(new Error("User Aborted"));
      }
      grunt.log.ok("Started deleting nodes...");
      var iterator = function (node, iterationDone) {
        var client = pkgcloud.compute.createClient(options.pkgcloud.client);
        client.destroyServer(node.id, function (err, result) {
          if (err)
            return utils.handleErr(err, iterationDone, true);
          var deleted = false;
          async.until(
            function () {
              return deleted
            },
            function (callback) {
              utils.queryNode(options, node.id, function (err, node) {
                if (err && err.statusCode == 404) {
                  deleted = true;
                  return callback();
                } else {
                  return callback(err);
                }
              });
            },
            function (err) {
              if (err) {
                return utils.handleErr(err, iterationDone, false);
              } else {
                grunt.log.ok("Deleted node: " + result.ok);
                return iterationDone();
              }
            }
          );
        });
      };
      var iteratorStopped = function (err) {
        return next(err);
      };
      utils.iterateOverClusterNodes(options, null, iterator, iteratorStopped, false);
    }
  ], function (err) {
    if (err)
      return utils.handleErr(err, gruntDone, false);
    grunt.log.ok("Done deleting nodes.");
    return gruntDone();
  })
};
node.destroy.description = "Destroy node VMs of cluster";

/**
 * Add all hosts in the cluster to the /etc/hosts of every ACTIVE node
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options The task parameters
 * @param {Function} gruntDone
 *          done Callback to call when the requests are completed
 */
node.dns = function (grunt, options, gruntDone) {
  // Check configuration file
  try {
    var username = options.pkgcloud.client.sshusername;
  } catch (err) {
    grunt.fail.warn("user name for ssh has not been defined");
    return gruntDone(err);
  }
  grunt.log.ok("Started updating /etc/hosts file on each ACTIVE node ...");
  // Serial Asynchronous works start
  async.waterfall([
    // Get cluster nodes's ip-name pair
    function (next) {
      var hosts = [];
      var iterator = function (node, iterationDone) {
        hosts.push(node.ipv4 + " " + node.name);
        return iterationDone();
      };
      var iteratorStopped = function (err) {
        return err ? utils.handleErr(err, next, false) : next(null, hosts);
      };
      utils.iterateOverClusterNodes(options, "", iterator, iteratorStopped, true);
    },
    // Edit hosts file on each ALIVE node
    function (hosts, next) {
      var iterator = function (node, iterationDone) {
        var dnsHead = "# Cluster " + options.cluster + " DNS Settings Start";
        var dnsEnd = "# Cluster " + options.cluster + " DNS Settings End";
        var contentToAppend = dnsHead + "\n" + hosts.join("\n") + "\n" + dnsEnd;
        var cmdRemoveOldSettings = "sudo sed -i '/" + dnsHead + "/,/" + dnsEnd + "/d' /etc/hosts";
        var cmdAppendSettings = "sudo echo '" + contentToAppend + "' | cat - /etc/hosts > temp && sudo mv temp /etc/hosts";
        var cmdStr = cmdRemoveOldSettings + " && " + cmdAppendSettings;
        sshExec(username, node.ipv4, cmdStr, function (err) {
          utils.handleErr(err, iterationDone, true);
          grunt.log.ok("Done appending hosts to " + node.name);
          return iterationDone();
        });
      };
      var iteratorStopped = function (err) {
        return err ? utils.handleErr(err, next, false) : next(null);
      };
      utils.iterateOverClusterNodes(options, "active", iterator, iteratorStopped, false)
    }
  ], function (err) {
    return err ? utils.handleErr(err, gruntDone, false) : gruntDone();
  });
};
node.dns.description = "Build local DNS for all cluster nodes"

node.exec = function (grunt, options, gruntDone) {
  // Check configuration file
  try {
    var username = options.pkgcloud.client.sshusername;
  } catch (err) {
    grunt.fail.warn("user name for ssh has not been defined");
    return gruntDone(err);
  }
  var nodeNameIndx = grunt.option('i');
  console.log(nodeNameIndx);
  var cmdStr = grunt.option('c');
  console.log("Exec command: " + cmdStr);
  var iterator = function(node, iterationDone){
    if (nodeNameIndx && (!node.name.includes(nodeNameIndx)))
      return iterationDone();
    sshExec2(username, node.ipv4, cmdStr, function (err, stdout, stderr) {
      grunt.log.ok("Start running cmd at " + node.name);
      utils.handleErr(err, iterationDone, true);
      console.log(stdout);
      if(stderr)
        console.log(stderr);
      grunt.log.ok("Done running cmd at " + node.name);
      return iterationDone();
    });
  };
  var iteratorStopped = function (err) {
    return err ? utils.handleErr(err, gruntDone, false) : gruntDone();
  };
  utils.iterateOverClusterNodes(options, "active", iterator, iteratorStopped, false);
};
node.exec.description ="Run a command on each node via ssh using flag -c";



function composeNodesTable(nodes) {
  var nodesList = _.toArray(nodes);
  var sortedNodesList = _.sortBy(nodesList, "hostName");
  var nodePutleList = _.map(sortedNodesList, function (nodeTuple) {
    return _.toArray(nodeTuple);
  })
  var Table = require('cli-table');
  var table = new Table({
    head: ['Id'.cyan, 'Name'.cyan, 'Zone:Ipv4'.cyan, 'Status'.cyan],
    colWidths: [],
    style: {compact: true, 'padding-left': 0, 'padding-right': 0},
    chars: {
      'top': '═', 'top-mid': '╤', 'top-left': '╔', 'top-right': '╗'
      , 'bottom': '═', 'bottom-mid': '╧', 'bottom-left': '╚', 'bottom-right': '╝'
      , 'left': '║', 'left-mid': '╟', 'mid': '─', 'mid-mid': '┼'
      , 'right': '║', 'right-mid': '╢', 'middle': '│'
    }
  });
  table.push.apply(table, nodePutleList);
  return table.toString();
}

function changeStatusColor(hostStatus) {
  switch (hostStatus) {
    case 'RUNNING':
      hostStatus = hostStatus.green;
      break;
    case 'PROVISIONING':
    case 'UPDATING':
    case 'REBOOT':
      hostStatus = hostStatus.yellow;
      break;
    default:
      hostStatus = hostStatus.red;
      break;

  }
  return hostStatus;
}

function promptBeforeDestroy(callback) {
  var rl = require("readline").createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question("Going to destroy all cluster nodes. Are you sure? (y/N)", function (answer) {
    if (!(answer.toUpperCase() == "Y" || answer.toUpperCase() == "YES")) {
      return callback(false);
    } else {
      return callback(true);
    }
  })
}

function sshExec(username, address, cmd, callback) {
  exec(["ssh", '-o "StrictHostKeyChecking no"', username + "@" + address, "-C"].concat('"' + cmd + '"').join(" "), callback);
}

function sshExec2(username, address, cmd, callback) {
  exec(["ssh", '-t -T', '-o "StrictHostKeyChecking no"', username + "@" + address, "-C"].concat('"' + cmd + '"').join(" "), callback);
}