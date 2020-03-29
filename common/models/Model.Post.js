
const jugglerUtils = require('loopback-datasource-juggler/lib/utils');
const request = require('superagent');
const {IncomingForm} = require('formidable');

/**
 * Merge include options of default scope with runtime include option.
 * exhibits the _.extend behaviour. Property value of source overrides
 * property value of destination if property name collision occurs
 * @param {String|Array|Object} destination The default value of `include` option
 * @param {String|Array|Object} source The runtime value of `include` option
 * @returns {Object}
 */

module.exports = function(Model) {
  const debug = require('debug')('component:blog:post');
  let app;

  Model.disableRemoteMethodByName('create');
  Model.disableRemoteMethodByName('replaceOrCreate');

  Model.once('attached', (a) => {
    app = a;
    const router = app.loopback.Router();
    const settings = app.settings;
    const deleteById = Model.deleteById;
    const models = Model.app.models;

    Model.deleteById = (id, cb) => {
      Model.updateAll({id: id}, {
        deletedAt: new Date(),
        deletedBy: cb.accessToken.userId,
      }, cb);
    };

    /** *************** REMOTE HOOK *************** **/

    Model.beforeRemote('find', (ctx, _, next) => {
      let currentFilter = ctx.args.filter || {};
      let includeRelations = {};
      Object.keys(Model.relations).forEach((related) => {
        includeRelations[related] = null;
      });
      // override current filter include
      if (currentFilter.include) {
        currentFilter.include =
          jugglerUtils.mergeIncludes(includeRelations, currentFilter.include);
      } else {
        currentFilter.include =
          jugglerUtils.mergeIncludes(includeRelations, currentFilter.include);
      }

      ctx.args.filter = currentFilter;
      /* istanbul ignore next */
      next();
    });

    Model.afterRemote('find', (ctx, _, next) => {
      let result = ctx.result;
      ctx.result = result.filter((instance) => {
        return !instance.deletedAt;
      });
      /* istanbul ignore next */
      next();
    });

    /** ************* OPERATION HOOK ************* **/

    Model.observe('before save', (ctx, next) => {
      let userId = null;
      if (undefined !== ctx.options.accessToken) {
        userId = ctx.options.accessToken && ctx.options.accessToken.userId;
      }
      ctx.hookState.relations = {};
      if (ctx.isNewInstance && ctx.instance) {
        Object.keys(Model.relations).forEach((related) => {
          ctx.hookState.relations[related] = ctx.instance [related]();
        });
      } else if (ctx.instance) {
        Object.keys(Model.relations).forEach((related) => {
          ctx.hookState.relations[related] = ctx.instance [related]();
        });
      }
      if (ctx.instance && ctx.instance.id) {
        ctx.instance.modifiedBy = userId || ctx.instance.createdBy;
        ctx.instance.createdBy = ctx.instance.createdBy || userId;
        ctx.instance.modifiedAt = new Date();
      } else if (ctx.isNewInstance) {
        ctx.instance.createdBy = userId || ctx.instance.createdBy;
        ctx.instance.createdAt = new Date();
      }
      /* istanbul ignore next */
      next();
    });

    Model.observe('after save', (ctx, next) => {
      const promises = [];
      if (ctx.instance) {
        ctx.instance.modifiedAt = new Date();
        Object.keys(Model.relations).forEach((related) => {
          let promiseArray = [];
          const data = ctx.hookState.relations[related];
          if (typeof data !== 'undefined') {
            const relatedId = Model.relations[related].modelTo.getIdName();
            let promise = Promise.resolve('ready');
            /* istanbul ignore if [cannot access ctx object] */
            if (data[relatedId]) {
              promise = ctx.instance[related].update(data);
            } else if (Object.keys(data).indexOf('0') > -1) {
              promiseArray = data.map((item) => {
                let promise = Promise.resolve('ready');
                if (item[relatedId]) {
                  promise = ctx.instance[related].updateById(item.id, item);
                } else {
                  promise = ctx.instance[related].create(item);
                }
                return promise;
              });
            }
            /* istanbul ignore if [async code] */
            /* istanbul ignore else [async code] */
            if (promiseArray.length > 0) {
              ctx.instance.__data[related] = [];
              promiseArray.forEach((promiseInArray) => {
                promise = promiseInArray.then((record) => {
                  ctx.instance.__data[related].push(record);
                  return ctx;
                });
                promises.push(promise);
              });
            } else {
              promise = promise.then((record) => {
                ctx.instance.__data[related] = record;
                return ctx;
              });
              promises.push(promise);
            }
          }
        });
        Promise.all(promises).then(() => next()).catch(err => next(err));
      }
    });

    /** *************** REMOTE HOOK *************** **/

    Model.beforeRemote('find', (ctx, _, next) => {
      let currentFilter = ctx.args.filter || {};
      currentFilter.order = 'id DESC';

      ctx.args.filter = currentFilter;
      next();
    });

    async function saveMedia(file, token) {
      const blogConfig = settings['component-blog'];
      const url = blogConfig['baseUrl'] + blogConfig['uploadMediaUrl'] +
        `?access_token=${token}`;
      try {
        return await request
          .post(url)
          .attach('file', file.path, {filename: file.name})
          .then((response) => {
            return response.body.result;
          }).catch(err => {
          });
      } catch (err) {
        console.log('Error while saving media: ', err);
      }
    }

    // replaces the POST
    Model.new = (req, cb) => {
      const token = req.query.access_token;
      const form = new IncomingForm();
      form.multiples = true;
      let finalRes = [];
      try {
        form.parse(req, (err, fields, files) => {
          fields.createdBy = req.accessToken.userId;
          let body = Model.create(fields);

          finalRes = files.file.map(async(file) => {
            let fileStorage = await saveMedia(file, token);
            return fileStorage.files;
          });

          finalRes = [body, ...finalRes];
          Promise.all(finalRes).then(function(responses) {
            const mediaPromises = [];
            responses.forEach(async(response, i) => {
              if (i !== 0) {
                let media = await models.PostMedia.create({
                  path: response[0].url,
                  postId: responses[0].id,
                  filesId: response[0].id,
                  createdBy: response[0].createdBy,
                  createdAt: response[0].createdAt,
                });
                mediaPromises.push(media);
              }
            });
            Promise.all(mediaPromises).then(function(result) {
              cb(null, responses[0]);
            });
          }).catch(err => { console.log(err); });
        });
      } catch (err) {
        console.log('Response error: ', err);
      }
      // the files are available as req.files.
      // the body fields are available in req.body
    };

    Model.remoteMethod(
      'new',
      {
        accepts: [
          {
            arg: 'req',
            type: 'object',
            http: function(ctx) {
              return ctx.req;
            },
          },
        ],
        returns: {arg: 'result', type: 'object'},
        http: {status: 200},
        description: 'An alternate API for creating a new post',
      }
    );
  });
};
