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

volume.create = function (grunt, option, gruntDone) {
  grunt.log.ok("Started creating volumes...");
  var nodeIterator = function (node, nextNode) {
    async.each(node.nodeOption.volumes, function (volName, nextVol) {
      var volumeType = _.find(option.volumetypes, function (volumetype) {
        return volumetype.name === volName;
      });
      volumeType = _.extend(_.clone(volumeType), {name: utils.volumeName(volumeType.name, node.name)});
      console.log(JSON.stringify(volumeType));
      pkgcloud.blockstorage.createClient(option.pkgcloud.client).createVolume(volumeType, function (err, result) {
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

  utils.iterateOverClusterNodes(option, "", nodeIterator, iteratorStopped, false);
};
volume.create.description="Create Volumes for nodes";



