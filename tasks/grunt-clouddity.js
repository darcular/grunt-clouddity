/*
 * grunt-clouddity
 * Grunt tasks to deploy on a cluster
 * 
 * Copyright (c) 2016 Yikai Gong
 * Licensed under the MIT license.
 */

"use strict";

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
        require("./lib/docker"),
        require("./lib/securitygroup")
    );
    console.log(funcModule);

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
        args = _.union([grunt, options, callback], args);
        taskFunction.apply(this, args);
    };

    // Register tasks for each command
    _.each(funcModule, function (value, key) {

        // Register all first level functions in loaded module.
        if (_.isFunction(value)) {
            var taskName = pluginName + ":" + key;
            var description = value.description;
            grunt.task.registerTask(taskName, description, function () {
                // Call executor by 'this' (An caller object created by grunt)
                execTask.apply(this, [value, arguments]);
            });
        }

        // Register all second level functions in loaded module.
        _.functions(value).forEach(function (funcName) {
            var taskName = pluginName + ":" + key + ":" + funcName;
            var description = value[funcName].description;
            grunt.task.registerTask(taskName, description, function () {
                execTask.apply(this, [value[funcName], arguments]);
            });
        });
    });

    // Map other un-registered plugin-prefix task to a warning function.
    grunt.task.registerTask(pluginName, pluginDescription, function () {
        var input = pluginName + ":" + _.toArray(arguments).join(':');
        grunt.fail.warn('Invalid input "' + input + '" for plugin ' +
            '"grunt-' + pluginName + '".\nUse --help to find out usage.');
    });
};
