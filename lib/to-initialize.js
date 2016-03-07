/**
 * Module dependencies
 */

var util = require('util');
var _ = require('lodash');
var async = require('async');
var prompt = require('prompt');
var loadModelsAndCustomAdapters = require('./lib/load-models-and-custom-adapters');
var validateDatastoreConfig = require('./lib/validate-datastore-config');
var validateModelDef = require('./lib/validate-model-def');
var buildWaterlineOntology = require('./lib/build-waterline-ontology');



/**
 * toInitialize()
 *
 * Get the `.initialize()` function for this hook.
 *
 * @param  {Dictionary} hook
 * @param  {SailsApp} sails
 * @return {Function}
 */
module.exports = function toInitialize(hook, sails){

  /**
   * `initialize()`
   *
   * @param  {Function} done
   */
  return function initialize(done){
    sails.log.debug('\n-----------------\nThis app is loading a custom version of the `orm` hook.  See https://github.com/mikermcneil/sails-hook-orm for more information.\n-----------------');

    ////////////////////////////////////////////////////////////////////////////
    // NOTE: If a user hook needs to add or modify model definitions,
    // the hook should wait until `hook:orm:loaded`, then reload the original
    // model modules `orm/loadAppModules`. Finally, the ORM should be flushed using
    // `reload()` below.
    ////////////////////////////////////////////////////////////////////////////

    async.auto({


      // Load model and adapter definitions which are defined in the project.
      // (this is from e.g. `api/models/` and `api/adapters/`--
      //  note that this does NOT include adapters which need to be loaded from the node_modules directory!)
      _loadModelsAndCustomAdapters: function (next) {
        loadModelsAndCustomAdapters(hook, sails, next);
      },


      // Load any adapters for datastores with "forceLoadAdapter"
      // (this is because otherwise, the adapters for datastores not referenced from models will not be loaded)
      _forceLoadAdapters: function(next) {
        try {
          _.each(sails.config.connections, function _eachDatastoreConfig(datastoreConfig, datastoreIdentity) {
            if (datastoreConfig.forceLoadAdapter) {
              validateDatastoreConfig(datastoreIdentity, '<FORCE>', hook, sails);
            }
          });
        }
        catch (e) { return next(e); }
        return next();
      },

      _attemptToLoadUnrecognizedAdapters: function (next){
        // TODO: pull out code that loads adapter from node_modules and include here
        // (currently it is handled by _forceLoadAdapters and/or _normalizeModelDefs, which is a bit weird.)
        return next();
      },


      // Expose `hook.datastores`; dictionary indexed by datastore identity.
      _buildAndExposeDatastores: ['_attemptToLoadUnrecognizedAdapters', function (next){

        hook.datastores = _.reduce(sails.config.connections, function _eachDatastoreConfig(memo, datastoreConfig, identity) {
          // Each "datastore" is actually its own dictionary
          memo[identity] = {};

          // Which exposes a reference to normalized datastore config as `.config`:
          memo[identity].config = datastoreConfig;

          // And a reference to relevant normalized adapter as `.adapter`:
          // (at this point, we've already loaded and validated the adapter, so if we're here, we know an adapter exists)
          memo[identity].adapter = hook.adapters[datastoreConfig.adapter];

          // If relevant adapter exposes a compatible `.driver`, then the datastore also exposes a great deal more.
          if (hook.adapters[datastoreConfig.adapter].driver) {
            // TODO: validate driver

            // • `.driver` (the entire driver)
            memo[identity].driver = hook.adapters[datastoreConfig.adapter].driver;

            // • `.manager` (the manager returned from when the driver's `createManager()` method was called)
            // TODO

            // • 3 new methods:
            //   ° `.connect(during)`
            //   ° `.transaction(during)`
            //   ° `.query(radarStatement)`
            //   Each of which return deferred objects which can be used as such:
            //   ```
            //   .meta(metadata) // optional
            //   .usingConnection(dbConnection) // optional
            //   .exec(afterwards)
            //   ```
            // TODO
          }

          return memo;
        }, {});

        return next();
      }],



      // Normalize model definitions and merge in defaults from `sails.config.models.*`.
      // This is what will be passed in to Waterline when building the ontology.
      _normalizeModelDefs: ['_loadModelsAndCustomAdapters', function (next) {
        try {
          _.each(_.keys(hook.models), function (identity) {
            var originalModelDef = hook.models[identity];
            var normalizedModelDef = validateModelDef(model, identity, hook, sails);
            // Note: prior to March 2016, the normalized def was merged back into
            // the original model def rather than replacing it.
            hook.models[identity] = normalizedModelDef;
          });
        }
        catch (e) { return next(e); }
        return next();
      }],


      // Before continuing any further to actually start up the ORM,
      // check the migrate settings for each model to prompt the user
      // to make a decision if no migrate configuration is present.
      //
      // Note that, if this is a production environment, the `migrate`
      // setting has already been forced to "safe" when the model
      // definitions were validated/normalized.
      _doubleCheckMigration: ['_normalizeModelDefs', function (next) {

        // If there are no models, we're good.
        if (_.keys(hook.models).length === 0) {
          return next();
        }

        // If a project-wide migrate setting (sails.config.models.migrate) is defined, we're good.
        if (typeof sails.config.models.migrate !== 'undefined') {
          return next();
        }

        // Otherwise show a prompt
        console.log('-----------------------------------------------------------------');
        console.log();
        prompt.start();
        console.log('',
          'Excuse my interruption, but it looks like this app'+'\n',
          'does not have a project-wide "migrate" setting configured yet.'+'\n',
          '(perhaps this is the first time you\'re lifting it with models?)'+'\n',
          '\n',
          'In short, this setting controls whether/how Sails will attempt to automatically'+'\n',
          'rebuild the tables/collections/sets/etc. in your database schema.\n',
          'You can read more about the "migrate" setting here:'+'\n',
          'http://sailsjs.org/#!/documentation/concepts/ORM/model-settings.html?q=migrate\n'
          // 'command(⌘)+click to open links in the terminal'
        );
        console.log('',
          'In a production environment (NODE_ENV==="production") Sails always uses'+'\n',
          'migrate:"safe" to protect inadvertent deletion of your data.\n',
          'However during development, you have a few other options for convenience:'+'\n\n',
          '1. safe  - never auto-migrate my database(s). I will do it myself (by hand)','\n',
          '2. alter - auto-migrate, but attempt to keep my existing data (experimental)\n',
          '3. drop  - wipe/drop ALL my data and rebuild models every time I lift Sails\n'
        );
        console.log('What would you like Sails to do?');
        console.log();
        sails.log.info('To skip this prompt in the future, set `sails.config.models.migrate`.');
        sails.log.info('(conventionally, this is done in `config/models.js`)');
        console.log();
        sails.log.warn('** DO NOT CHOOSE "2" or "3" IF YOU ARE WORKING WITH PRODUCTION DATA **');
        console.log();
        prompt.get(['?'], function(err, result) {
          if (err) { return next(err); }
          result = result['?'];

          switch (result) {
            case 'alter':
            case '2':
              sails.config.models.migrate = 'alter';
              break;
            case 'drop':
            case '3':
              sails.config.models.migrate = 'drop';
              break;
            default:
              sails.config.models.migrate = 'safe';
              break;
          }

          console.log();
          console.log(' Temporarily using `sails.config.models.migrate="%s"...', sails.config.models.migrate);
          console.log(' (press CTRL+C to cancel-- continuing lift automatically in 0.5 seconds...)');
          console.log();
          setTimeout(function (){
            return next();
          },600);
        });

      }],

      // Once all user model and adapter definitions are loaded
      // and normalized, go ahead and initialize the ORM.
      _buildOntology: ['_doubleCheckMigration', function (next, async_data) {
        // If `sails` is already exiting due to previous errors, bail out.
        if (sails._exiting) {
          // This is possible since we are doing asynchronous things in the initialize function,
          // and e.g. another hook may have failed to load in the mean time since we began initializing.
          // Also note that `reload()` below calls initialize again, so this could happen during that
          // process as well.
          return next(new Error('SAILS EXITING'));
        }

        buildWaterlineOntology(async_data._normalizeModelDefs, hook, sails, function (err, freshOntology) {
          if (err) { return next(err); }

          // Finally, continue onward, passing the ontology through as async_data.
          return next(null, freshOntology);
        });
      }],


      // Now take each of the "collection" instances returned by Waterline and modify them a bit for Sails.
      // Then stuff them back onto `hook.models`.
      _augmentAndExposeFinalModels: ['_buildOntology', function (next, async_data){

        try {
          _.each(async_data._buildOntology.collections, function _eachInstantiatedModel(wlModel, modelIdentity) {

            // Bind context (`this`) for models.
            // (this allows `this` to be used in custom model methods)
            _.bindAll(wlModel);

            // Expose a `.datastore` on this model which includes a reference to the relevant datastore dictionary
            // in `hook.datastores`.
            if (wlModel.datastore) {
              throw new Error('Consistency violation: Instantiated Waterline model already has a `datastore` property.');
            }
            else {
              wlModel.datastore = hook.datastores[wlModel.connection[0]];
            }

            // Derive information about this model's associations from its schema
            // and attach/expose the metadata as `SomeModel.associations` (an array)
            wlModel.associations = _.reduce(wlModel.attributes, function _eachAttribute(memo, attrDef, attrName) {
              // Skip non-associations.
              if (!util.isObject(attrDef) || (!attrDef.model && !attrDef.collection)) {
                return memo;
              }

              // Build an informational dictionary describing this association.
              var assocInfo = { alias: attrName };
              if (attrDef.model) {
                assocInfo.type = 'model';
                assocInfo.model = attrDef.model;
              }
              else if (attrDef.collection) {
                assocInfo.type = 'collection';
                assocInfo.collection = attrDef.collection;
                if (attrDef.via) {
                  assocInfo.via = attrDef.via;
                }
              }
              memo.push(assocInfo);
              return memo;
            }, []);

            // Set `hook.models.*` reference to our instantiated model.
            // Exposed as `hook.models[modelIdentity]`.
            hook.models[modelIdentity] = wlModel;

            // If configured to do so (based on `sails.config.globals.models`), then expose a reference
            // to this model as a global variable (based on its `globalId`).
            if (util.isObject(sails.config.globals) && sails.config.globals.models === true) {
              if (util.isString(hook.models[modelIdentity].globalId)) {
                global[hook.models[modelIdentity].globalId] = wlModel;
              }
              // If there is no `globalId`, fall back to the identity.
              // This is for backwards compatibility-- nowadays, Waterline
              // takes care of this automatically:
              else {
                global[modelIdentity] = wlModel;
              }
            }
          });//</each collection from Waterline>
        }//</try>
        catch (e) { return next(e); }

        return next();
      }],


    }, done);//</async.auto>
  };
};