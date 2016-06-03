/*
 * grunt-clouddity
 * Grunt tasks to deploy on a cluster
 * 
 * Copyright (c) 2016 Yikai Gong
 * Licensed under the MIT license.
 */

"use strict";

var _ = require("underscore");

module.exports = function (grunt) {

    // Load exported task functions
    var functions = require("lib/clouddity");

    var taskName = "clouddity";

    /**
     * Invoke task according to the input command. Load corresponding options
     * from grunt.config. Take a list of command/options as arguments from
     * command line input
     *
     *  grunt {taskName}:{command}:{opt1}:{opt2}:...
     */
    var processCommand = function () {
        // Pre-process arguments
        var args = _.toArray(arguments);
        var command = args[0] == undefined ? '' : args[0];
        var arg1 = args[1] == undefined ? '' : args[1];
        if (command == '') {
            grunt.fail.warn('Task "' + taskName + '" requires a command to invoke.' +
                '\nUsage: grunt ' + taskName + ':command:{optional_1}:{optional_2}.' +
                '\nUse --help to check out usage.');
        }

        // Load task options defined in grunt.initConfig({...}).
        var options = grunt.config.get(taskName);
        if (!options){
            grunt.fail.fatal('Cannot find "'+ taskName + '" in grunt.config. ' +
                'Please define options for Task "'+ taskName + '" in  grunt.initConfig({})');
        }

        // Load task function according to command (or command:arg1)
        // Abort task unless finding an existing function to assign to cmdFunc.
        var cmdFunc = functions[command];
        args = _.rest(args);  // remove command from args
        if (!cmdFunc) {
            grunt.fail.warn('Task "' + taskName + ':' + command + '" not found.' +
                '\nUsage: grunt ' + taskName + ':command:{option_1}:{option_2}.' +
                '\nUse --help to check out available commands.');
        } else if (typeof (cmdFunc) !== "function") {
            cmdFunc = cmdFunc[arg1];
            args = _.rest(args);
            if (typeof (cmdFunc) !== "function") {
                grunt.fail.fatal('Option "' + arg1 + '" for "' + taskName + ':' + command
                    + '" not found.');
            }
        }

        // Tell Grunt this is a asynchronous task.
        var done = this.async();

        // Callback function to be fired once task operation is completed.
        var callback = function (e) {
            if (e)
                grunt.fail.warn(e);
            // Inform grunt that this task has been finished.
            done(e);
        }

        // Merge clients configuration parameters with cmd options
        args = _.union([grunt, options, callback] ,args);
        cmdFunc.apply(this, args);
    };

    // Register tasks for each command
    _.keys(functions).forEach(function (command) {
        grunt.task.registerTask("do:" + command, function () {
            var args = this.args;
            args.unshift(command);
            // Call command processor via 'this'(A created object by parsing input command)
            processCommand.apply(this, args);
        });
    });

    // Map other un-registered "clouddity:command" to command processor,
    // thus it will print out usage hint.
    grunt.task.registerTask("clouddity", 'Grunt tasks to deploy on a cluster', function () {
        processCommand.apply(this, this.args);
    });
};
