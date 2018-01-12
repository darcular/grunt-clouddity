/**
 * @author Yikai Gong
 */

"use strict";

var pkgcloud = require("pkgcloud"), async = require("async");
var _ = require("underscore"), Docker = require("dockerode");

/**
 * Logs an error (if existing) on the Grunt error log, and calls the callback with or
 * without the err as arguments(e.g. continue an iterator when error appears in one
 * iteration)
 *
 * @param err {object}
 * @param done {function}
 * @param breakIterator {boolean}
 * @returns {*}
 */
module.exports.handleErr = function (err, done, ignoreErr) {
  if (err) {
    var message = err.message ? err.message : "Unknown error.";
    var result = err.result ? JSON.stringify(err.result) : "";
    require("grunt").log.error(message + " Result:" + result);
    if (ignoreErr) {
      return done();
    } else {
      return done(err);
    }
  }
};

module.exports.logErrMsg = function (err) {
  require("grunt").log.error(err.message + " " + JSON.stringify(err.result));
};

/**
 * Security Group Utils
 */
/**
 * Serial iterate over the active security groups in the cluster that
 * satisfy a filtering condition (it can be used to select only the security
 * groups in a given cluster)
 *
 * @param options {Object}
 *          options Task options
 * @param selector {Function}
 *          selector Function to select security groups to iterate over (it is
 *          passed the security group data and must return true if the group is
 *          to be selected)
 * @param iterator {Function}
 *          iterator The function is passed an Object containing the security
 *          group parameters, and a callback function to call when one iteration
 *          is complete (the callback is, if in error, sent an error object)
 * @param iteratorStopped {Function}
 *          done Callback to call when the requests are completed (an err
 *          parameter is passed if an error occurred)
 */
var iterateOverSecurityGroups = function (options, selector, iterator, iteratorStopped) {
  // Retrieves the active security groups
  var pkgcloudClient = pkgcloud.network.createClient(options.pkgcloud.client);
  var callback = function (err, activeGroups) {
    if (err) {
      module.exports.logErrMsg(err);
      return iteratorStopped(err);
    }
    async.eachSeries(_.filter(activeGroups, selector), iterator, iteratorStopped);
  };
  pkgcloudClient.getSecurityGroups(null, callback);
};

/**
 * Serial iterate over the SECURITY GROUPS belonging to the cluster (as
 * defined in the options)
 *
 * @param options {Object}
 *          options Task options
 * @param iterator {Function}
 *          iterator The function is passed an Object containing the security
 *          group parameters, and a callback function to call when one iteration
 *          is complete (the callback is, if in error, sent an error object)
 * @param iteratorStopped {Function}
 *          done Callback to call when the requests are completed (an err
 *          parameter is passed if an error occurred)
 *
 */
module.exports.iterateOverClusterSecurityGroups = function (options, iterator, iteratorStopped) {
  var selector = function (sec) {
    return module.exports.securitygroupCluster(sec.name) === options.cluster
  };
  iterateOverSecurityGroups(options, selector, iterator, iteratorStopped);
};

/**
 * Returns the name of security group given some parameters
 *
 * @param clusterName {String}
 *          clusterName Name of cluster the security group belongs to (must not
 *          contain dashes)
 * @param securityGroupName {String}
 *          securityGroupName Name of security group (must not contain dashes)
 *
 * @returns {String} Name of the secuirty group
 */
module.exports.securitygroupName = function (clusterName, securityGroupName) {
  return clusterName + "-" + securityGroupName;
};

/**
 * Returns the cluster name of a security group given its name
 *
 * @param secName {String}
 *          secName Name of security groups
 *
 * @returns {String} Name of cluster
 */
module.exports.securitygroupCluster = function (secName) {
  return secName.split("-")[0];
};

/**
 * Returns the name of a security group bar its cluster name
 *
 * @param {String}
 *          secName Name of security groups
 *
 * @returns {String} Plain name of the secuirty group
 */
module.exports.securitygroupPlainName = function (secName) {
  return secName.split("-")[1];
};

/**
 * Returns security groups in the format favored from OpenStack.
 *
 * @param clusterName {String}
 *          clusterName Name of cluster the security group belongs to (must not
 *          contain dashes)
 * @param secGroups {Array}
 *          secGroups Array of security group names
 * @return {Array} Array of Objects with name property only (like:
 *         "[{\"name\":\"secgroup1\"}, {\"name\":\"secgroup2\"}]")
 */
module.exports.composeClusterSecGrpNameList = function (clusterName, secGroups) {
  return _.map(secGroups, function (grp) {
    return {name: module.exports.securitygroupName(clusterName, grp)};
  });
};
/**
 * Node Utils
 */
/**
 * Returns a list of servers based on the node types defined in options
 *
 * @param options {Object}
 *          option Task Grunt options
 * @return {Array} Array of Objects containing all server definitions with
 *         replication (name is changed to the actual server one)
 */
module.exports.getDefinedNodes = function (options) {
  var nodes = [];
  var nodeTypes = options.nodetypes;
  nodeTypes.forEach(function (nodeType) {
    for (var i = 1; i <= nodeType.replication; i++) {
      var node = JSON.parse(JSON.stringify(nodeType));
      node.type = nodeType.name;
      node.name = module.exports.nodeName(options.cluster, node.type, i);
      nodes.push(node);
    }
  });
  return nodes;
};

/**
 * Iterate over the the servers active in the cloud that satisfy the cluster's name
 *
 * @param options {Object}
 *          Client credential of cloud user
 * @param status {String}
 *          Status of the node to be requested
 * @param iterator {Function}
 *          iterator The function is passed an Object containing the iterator
 *          parameters, and a callback function to call when one iteration is
 *          complete (the callback is, if in error, sent an error object)
 * @param iteratorStopped {Function}
 *          done Callback to call when the requests are completed (an err
 *          parameter is passed if an error occurred)
 * @param serial {Boolean}
 *          If using serial iteration
 */
module.exports.iterateOverClusterNodes = function (options, status, iterator, iteratorStopped, serial) {
  var client = pkgcloud.compute.createClient(options.pkgcloud.client);
  // Retrieves the active nodes IP addresses
  var queryOpt = {name: options.cluster};
  if (status && status !== "") {
    //noinspection JSValidateTypes
    queryOpt.status = status;
  }
  client.getServers(queryOpt, function (err, nodes) {
    module.exports.handleErr(err, iteratorStopped, false);
    // Extracts some data about the selected nodes and puts them back into nodes
    nodes = _.map(nodes, module.exports.preProcessNodeData.bind(options));
    // Calls the iterator for all the elements in data
    if (serial) {
      return async.eachSeries(nodes, iterator, iteratorStopped);
    } else {
      return async.each(nodes, iterator, iteratorStopped);
    }
  });
};

/**
 * Send a request to cloud provider for getting the status of a server
 *
 * @param options {Object} plugin configurations
 * @param serverId {String} Server Id of the requested VM
 * @param callback {Function} callback to fire after getting server's detail
 */
module.exports.queryNode = function (options, serverId, callback) {
  var client = pkgcloud.compute.createClient(options.pkgcloud.client);
  client.getServer(serverId, function (err, node) {
    if (!err) {
      node = exports.preProcessNodeData.call(options, node);
      callback(null, node);
    } else
      callback(err);
  });
}

/**
 * Returns the name of node given some parameters
 *
 * @param {String}
 *          clusterName Name of cluster the node belongs to (must not contain
 *          dashes)
 * @param {String}
 *          nodeType Type of node (must not contain dashes)
 * @param {Number}
 *          seq Sequential number of node
 *
 * @returns {String} Name of the node
 */
module.exports.nodeName = function (clusterName, nodeType, seq) {
  return clusterName + "-" + seq + "-" + nodeType;
};

/**
 * Returns the type of a node given its name
 *
 * @param {String}
 *          nodeName Name of node
 *
 * @returns {String} Type of node
 */
module.exports.nodeType = function (nodeName) {
  return nodeName.split("-")[2];
};

module.exports.preProcessNodeData = function (node) {
  var _node = {}
  _node.id = node.id ? node.id : "";
  _node.name = node.name ? node.name : "";
  _node.address = _.keys(node.addresses).length > 0 ? _.keys(node.original.addresses)[0] + ": " + node.addresses.public[0] : "";
  _node.ipv4 = _.keys(node.addresses).length > 0 ? node.addresses.public[0] : "";
  _node.type = node.name ? module.exports.nodeType(node.name) : "";
  _node.status = node.status ? node.status : "";
  var filteredNodeOptions = _.filter(this.nodetypes, function (nodetype) {
    return nodetype.name === module.exports.nodeType(_node.name)
  });
  var nodeOption = filteredNodeOptions.length > 0 ? filteredNodeOptions[0] : undefined;
  var images = filteredNodeOptions.length > 0 ? filteredNodeOptions[0].images : [];
  if (nodeOption) {
    _node.nodeOption = nodeOption;
    _node.images = images;
    _node.docker = {
      protocol: this.docker.client.protocol,
      host: _node.ipv4,
      port: this.docker.client.port,
      auth: this.docker.client.auth
    }
  }
  return _node;
}

/**
 * Dock Utils
 */
/**
 * Executes a function over the images of all the nodes in the cluster
 *
 * @param {Object} grunt
 *          grunt The Grunt instance
 * @param {Object} options
 *          options Task options
 * @param {Function} iterator
 *          iterator The function is passed an Object containing the image, the
 *          node, and a callback function to call when one iteration is complete
 *          (the callback is, if in error, sent an error object)
 * @param {Function} iteratorStopped
 *          done Callback to call when the requests are completed (an err
 *          parameter is passed if an error occurred)
 * @param  {Boolean} serial
 */
module.exports.iterateOverClusterImages = function (grunt, options, iterator, iteratorStopped, serial) {
  module.exports.iterateOverClusterNodes(
    options,
    "",
    function (node, callback) {
      // Puts in pulls all the images defined in the Gruntfile that
      // appear in the current node and adds the node parameters
      var defImages = grunt.config.get().dock.options.images;
      var nodePulls = [];
      var dock = grunt.config.get().dock;
      _.keys(defImages).forEach(function (imageName) {
        var image = _.clone(defImages[imageName]);
        image.auth = dock.options.auth;
        image.registry = dock.options.registry;
        image.docker = dock.options.docker;
        image.dockerclient = dock.options.dockerclient;
        image.name = imageName;
        image.repo = dock.options.registry + "/" + image.repo + ":" + image.tag;
        image.node = node;
        nodePulls.push(image);
      });
      nodePulls = _.filter(nodePulls, function (image) {
        return node.nodeOption.images.indexOf(image.name) >= 0;
      });
      async.eachSeries(nodePulls, iterator, function (err) {
        // FIXME May need handle err
        callback();
      });
    },
    function (err) {
      if (err) {
        return iteratorStopped(err);
      }
      return iteratorStopped();
    },
    serial
  );
};

module.exports.iterateOverClusterContainers = function (grunt, options, iterator, done) {

  // Iterates over all the nodes in the cluster and
  // puts in containers data about the containers running on the current node
  var containers = [];
  module.exports.iterateOverClusterNodes(
    options,
    "ACTIVE",
    function (node, next) {
      var reqOption = {all: true};
      (new Docker(node.docker)).listContainers(reqOption, function (err, nodeContainers) {
        if (err) {
          grunt.log.error(err);
          return next(err);
        }
        nodeContainers.forEach(function (container) {
          containers.push({
            node: node,
            container: container
          });
        });
        next();
      });
    },
    function (err) {
      // For every container executes the iterator function and skips errors
      async.eachSeries(containers, iterator, function (err) {
        if (err) {
          grunt.log.error(err);
        }
        done();
      });
    },
    true
  );
};

/**
 * Returns true if the container is to be processed (that is, either nodetype,
 * nodeid, and containerid Grunt option are both not defined, or the container
 * has the id given in containerId, or the node has the id given in nodeId, or
 * the container has the type given in nodeType
 *
 * @param {String}
 *          grunt Grunt object
 * @param {String}
 *          nodeType Cluster node type
 * @param {String}
 *          nodeId Cluster node ID
 * @param {String}
 *          imageType Image node name
 * @param {String}
 *          containerId Current container ID
 *
 * @returns {String} Name of cluster
 */
// TODO 
module.exports.isContainerToBeProcessed = function (grunt, nodeType, nodeId, imageName, containerId) {
  return (!grunt.option("nodetype") && !grunt.option("containerid") && !grunt
      .option("nodeid"))
    || (grunt.option("containerid") && containerId && containerId === grunt
      .option("containerid"))
    || (grunt.option("nodeid") && nodeId && nodeId === grunt.option("nodeid"))
    || (grunt.option("nodetype") && grunt.option("nodetype") === nodeType && _
      .find(grunt.config("clouddity.nodetypes"), function (nodetype) {
        return nodetype.name === nodeType;
      }).images.indexOf(imageName) >= 0);
};

/**
 * Executes a function over the images of all the nodes in the cluster
 *
 * @param {Object}
 *          grunt The Grunt instance
 * @param {Object}
 *          options Task options
 * @param {Function}
 *          iterator The function is passed an Object with data about node and
 *          container, the node, and a callback function to call when one
 *          iteration is complete (the callback is, if in error, sent an error
 *          object)
 * @param {Function}
 *          done Callback to call when the requests are completed (an err
 *          parameter is passed if an error occurred)
 */
module.exports.iterateOverClusterDockerImages = function (grunt, options,
                                                          iterator, done) {

  // Iterates over all the nodes in the cluster and
  // puts in images data about the images storing on the current node
  module.exports.iterateOverClusterNodes(
    options,
    "ACTIVE",
    function (node, next) {
      var images = [];
      (new Docker(node.docker)).listImages({}, function (err, nodeImages) {
        if (err) {
          grunt.log.error(err);
          return next(err);
        }

        nodeImages.forEach(function (image) {
          images.push({
            node: node,
            image: image
          });
        });
        // For every image executes the iterator function and skips errors
        async.eachSeries(images, iterator, function (err) {
          if (err) {
            grunt.log.error(err);
          }
        });

        return next();
      });
    },
    function (err) {
      if (err) {
        grunt.log.error(err);
        return done(err);
      }
    },
    false
  );
};