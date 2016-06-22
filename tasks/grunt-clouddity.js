'use strict';

// Plugin name setting
var pluginName = "clouddity";
var pluginDescription = "Plugin for easing clusters deployment";

// Lib
var _ = require("underscore");

// Entrance for loading plugin tasks
module.exports = function (grunt) {

  // Load exported tasks stack module.
  var funcModule = _.extend(
    require("./lib/node"),
    require("./lib/securityGroup"),
    require("./lib/docker")
  );

  /**
   * Load configurations for this plugin and prepare other arguments.
   * Invoke the input function at the end.
   */
  function execTask(taskFunction, argsOjb) {
    // Pre-process arguments
    var args = _.toArray(argsOjb);

    // Load plugin configuration defined in grunt.initConfig({...}).
    var config = grunt.config.get(pluginName);
    if (!config) {
      grunt.fail.fatal('Cannot find "' + pluginName + '" in grunt.config. ' +
        'Please put configurations for plugin "' + pluginName + '" in  grunt.initConfig({})');
    }

    // Tell Grunt this is a asynchronous task.
    var done = this.async();

    // Callback function to be fired once task operation is completed.
    var callback = function (e) {
      if (e)
        grunt.fail.warn(e);
      // Inform grunt that this task has been finished.
      done(e);
    };

    // Merge clients configuration parameters with cmd options
    args = _.union([grunt, config, callback], args);
    taskFunction.apply(this, args);
  };

  // Iteratively register each command "grunt plugin:cmd1:cmd2:..."
  function registerTask(funcRepo, prefix) {
    _.keys(funcRepo).forEach(function (key) {
      var value = funcRepo[key];
      if (_.isFunction(value)) {
        var taskName = prefix + ":" + key;
        var description = value.description;
        grunt.task.registerTask(taskName, description, function () {
          // Call executor by 'this' (An caller object created by grunt)
          execTask.apply(this, [value, arguments]);
        });
      }
      if (_.keys(value).length > 0) {
        registerTask(value, prefix + ":" + key);
      }
    });
  }

  registerTask(funcModule, pluginName);

  // Map other un-registered plugin-prefix task to a warning function.
  grunt.task.registerTask(pluginName, pluginDescription, function () {
    var input = pluginName + ":" + _.toArray(arguments).join(':');
    grunt.fail.warn('Invalid input "' + input + '" for plugin ' +
      '"grunt-' + pluginName + '".\nUse --help to find out usage.');
  });
};
