/**
 * @author Yikai Gong
 */
"use strict";

var _ = require('underscore'), async = require("async");
var exec = require('child_process').exec, pkgcloud = require("pkgcloud");
var logUpdate = require('log-update');
var utils = require("../../utils/utils");

var volume = {};
module.exports.volume = volume;

volume.create = function (grunt, options, gruntDone) {
  grunt.log.ok("Started creating volumes...");
  var nodeIterator = function (node, nextNode) {
    async.each(node.nodeOption.volumes, function (volName, nextVol) {
      var volumeType = _.find(options.volumetypes, function (volumetype) {
        return volumetype.name === volName;
      });
      volumeType = _.extend(_.clone(volumeType), {name: utils.volumeName(volumeType.name, node.name)});
      console.log(JSON.stringify(volumeType));
      pkgcloud.blockstorage.createClient(options.pkgcloud.client).createVolume(volumeType, function (err, result) {
        if (err)
          utils.handleErr(err, nextVol, true);
        grunt.log.ok("Created volume: " + result.name);
        nextVol();
      });
    }, function (err) {
      if (err)
        utils.handleErr(err, nextNode, true);
      grunt.log.ok("Done creating volumes for node " + node.nodeOption.name);
      nextNode();
    });
  };
  var iteratorStopped = function (err) {
    if (err)
      return utils.handleErr(err, gruntDone, false);
    grunt.log.ok("Done creating volumes.");
    return gruntDone();
  };

  utils.iterateOverClusterNodes(options, "", nodeIterator, iteratorStopped, false);
};
volume.create.description = "Create Volumes for nodes.";

volume.attach = function (grunt, options, gruntDone) {
  grunt.log.ok("Started attaching volumes...");
  utils.iterateOverVolumes(options, function (volume, nextVol) {
    utils.iterateOverClusterNodes(options, "", function (node, nextNode) {
      async.each(node.nodeOption.volumes, function (volName, next) {
        if (utils.volumeName(volName, node.name) === volume.name) {
          console.log(JSON.stringify(node));
          console.log(JSON.stringify(volume));
          pkgcloud.compute.createClient(options.pkgcloud.client).attachVolume(
            node.id, volume.id, function (err, result) {
              // if (err)
                // utils.handleErr(err, next, true);
              grunt.log.ok("Attached volume: " + JSON.stringify(result));
              next();
            });
        }
        else
          next();
      }, function (err) {
        if(err) utils.handleErr(err, nextNode, true);
        nextNode();
      });

    }, function (err) {
      if (err) utils.handleErr(err, nextVol, true);
      nextVol();
    }, true);
  },gruntDone);
};
volume.attach.description = "Attach Volumes to nodes.";

volume.detach = function (grunt, options, gruntDone) {
  grunt.log.ok("Started detaching volumes...");
  utils.iterateOverVolumes(options, function (volume, nextVol) {
    // console.log(volume.name);
    utils.iterateOverClusterNodes(options, "", function (node, nextNode) {
      // console.log(node.name);
      async.each(node.nodeOption.volumes, function (volName, next) {
        // console.log(utils.volumeName(volName, node.name));
        if (utils.volumeName(volName, node.name) == volume.name) {
          pkgcloud.compute.createClient(options.pkgcloud.client).detachVolume(
            node.id, volume.id, function (err, result) {
              grunt.log.ok("Detached volume from "+ node.name +": " + JSON.stringify(result));
              next();
            });
        } else
          next();

      }, function (err) {
        if(err) utils.handleErr(err, nextNode, true);
        nextNode();
      });

    }, function (err) {
      if (err) utils.handleErr(err, nextVol, true);
      nextVol();
    }, true);
  },gruntDone);
};
volume.detach.description = "Detach Volumes from nodes.";
