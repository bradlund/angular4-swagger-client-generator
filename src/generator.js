'use strict';

var fs = require('fs');
var Mustache = require('mustache');
var _ = require('lodash');

var Generator = (function () {

    function Generator(swaggerfile, outputpath) {
        this._swaggerfile = swaggerfile;
        this._outputPath = outputpath;
    }

    Generator.prototype.Debug = false;

    Generator.prototype.initialize = function () {
        this.LogMessage('Reading Swagger file', this._swaggerfile);
        var swaggerfilecontent = fs.readFileSync(this._swaggerfile, 'UTF-8');

        this.LogMessage('Parsing Swagger JSON');
        this.swaggerParsed = JSON.parse(swaggerfilecontent);

        this.LogMessage('Reading Mustache templates');

        this.templates = {
            'class': fs.readFileSync(__dirname + '/../templates/angular2-service.mustache', 'utf-8'),
            'model': fs.readFileSync(__dirname + '/../templates/angular2-model.mustache', 'utf-8'),
            'model_base': fs.readFileSync(__dirname + '/../templates/angular2-model-base.mustache', 'utf-8'),
            'models_export': fs.readFileSync(__dirname + '/../templates/angular2-models-export.mustache', 'utf-8')
        };

        this.LogMessage('Creating Mustache viewModel');
        this.viewModel = this.createMustacheViewModel();

        this.initialized = true;
    };

    Generator.prototype.generateAPIClient = function () {
        if (this.initialized !== true) {
            this.initialize();
        }

        this.generateClient();
        this.generateModels();
        this.generateCommonModelsExportDefinition();

        this.LogMessage('API client generated successfully');
    };

    Generator.prototype.generateClient = function () {
        if (this.initialized !== true) {
            this.initialize();
        }

        // generate main API client class
        this.LogMessage('Rendering template for API');
        var result = this.renderLintAndBeautify(this.templates.class, this.viewModel, this.templates);

        var outfile = this._outputPath + '/' + 'api.ts';
        this.LogMessage('Creating output file', outfile);
        fs.writeFileSync(outfile, result, 'utf-8')
    };

    Generator.prototype.generateModels = function () {
        var that = this;

        if (this.initialized !== true) {
            this.initialize();
        }

        var outputdir = this._outputPath + '/models';

        if (!fs.existsSync(outputdir)) {
            fs.mkdirSync(outputdir);
        }

        // generate API models				

        _.forEach(this.viewModel.definitions, function (definition) {
            that.LogMessage('Rendering template for model ', definition.name);

            // always write the base file
            var resultBase = that.renderLintAndBeautify(that.templates.model_base, definition, that.templates);
            var outfile = outputdir + '/_' + definition.name.toLowerCase() + '.model.ts';
            that.LogMessage('Creating base file', outfile);
            fs.writeFileSync(outfile, resultBase, 'utf-8');

            // only write the wrapper file if it doesn't already exist
            outfile = outputdir + '/' + definition.name.toLowerCase() + '.model.ts';
            if (!fs.existsSync(outfile)) {
                var resultWrapper = that.renderLintAndBeautify(that.templates.model, definition, that.templates);
                that.LogMessage('Wrapper does not exist, Creating file', outfile);
                fs.writeFileSync(outfile, resultWrapper, 'utf-8');
            }
            else {
                that.LogMessage('Wrapper already exists, skipping', outfile);
            }


        });
    };

    Generator.prototype.generateCommonModelsExportDefinition = function () {
        if (this.initialized !== true) {
            this.initialize();
        }

        var outputdir = this._outputPath;

        if (!fs.existsSync(outputdir)) {
            fs.mkdirSync(outputdir);
        }

        this.LogMessage('Rendering common models export');
        var result = this.renderLintAndBeautify(this.templates.models_export, this.viewModel, this.templates);

        var outfile = outputdir + '/models.ts';

        this.LogMessage('Creating output file', outfile);
        fs.writeFileSync(outfile, result, 'utf-8')
    };

    Generator.prototype.renderLintAndBeautify = function (template, model) {
        return Mustache.render(template, model);
    };

    Generator.prototype.createMustacheViewModel = function () {
        var that = this;
        var swagger = this.swaggerParsed;
        var authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
        var data = {
            isNode: false,
            description: swagger.info.description,
            isSecure: swagger.securityDefinitions !== undefined,
            swagger: swagger,
            domain: (swagger.schemes && swagger.schemes.length > 0 ? swagger.schemes[0] : 'http') + '://' +
            (swagger.host ? swagger.host : 'localhost') + ('/' === swagger.basePath ? '' : swagger.basePath),
            tags: [],
            definitions: []
        };

        // first get a list of all of the tags (which represent controllers in the backend).
        _.forEach(swagger.tags, function (tag) {
            var tagCameLcase = tag.name.replace(/\-[a-z]/g, function (t) {
                return t[1].toUpperCase();
            });

            data.tags.push({
                tag: tag.name,
                name: tagCameLcase,
                methods: []
            });
        });

        // a little inefficient to for loop twice, but On^2 isn't TOO horrible at the scale of parsing a swagger file.
        _.forEach(data.tags, function (tag) {
            _.forEach(swagger.paths, function (api, path) {
                var globalParams = [];
                _.forEach(api, function (op, m) {
                    if (m.toLowerCase() === 'parameters') {
                        globalParams = op;
                    }
                });

                _.forEach(api, function (op, m) {
                    if (authorizedMethods.indexOf(m.toUpperCase()) === -1) {
                        return;
                    }

                    var opTag = (op.tags && op.tags.length > 0) ? op.tags[0] : '';
                    if (opTag !== tag.tag) {
                        return;
                    }

                    // The description line is optional in the spec
                    var summaryLines = [];
                    if (op.description) {
                        summaryLines = op.description.split('\n');
                        summaryLines.splice(summaryLines.length - 1, 1);
                    }

                    var method = {
                        path: path,
                        backTickPath: path.replace(/(\{.*?\})/g, '$$$1').replace(/\$\{/g, '${this.safeUri(').replace(/\}/g, ')}'),
                        //methodName: op['x-swagger-js-method-name'] ? op['x-swagger-js-method-name'] : (op.operationId ? op.operationId : that.getPathToMethodName(m, path)),
                        methodName: op['x-swagger-js-method-name'] ? op['x-swagger-js-method-name'] : (op.summary ? op.summary : that.getPathToMethodName(m, path)),
                        method: m.toUpperCase(),
                        angular2httpMethod: m.toLowerCase(),
                        isGET: m.toUpperCase() === 'GET',
                        hasPayload: !_.includes(['GET', 'DELETE', 'HEAD'], m.toUpperCase()),
                        summaryLines: summaryLines,
                        isSecure: swagger.security !== undefined || op.security !== undefined,
                        parameters: [],
                        hasParameters: false,
                        hasJsonResponse: _.some(_.defaults([], swagger.produces, op.produces), function (response) { // TODO PREROBIT
                            return response.indexOf('/json') != -1;
                        })
                    };

                    var params = [];

                    if (_.isArray(op.parameters)) {
                        params = op.parameters;
                    }

                    params = params.concat(globalParams);

                    // Index file!
                    _.forEach(params, function (parameter) {
                        // Ignore headers which are injected by proxies & app servers
                        // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
                        if (parameter['x-proxy-header'] && !data.isNode) {
                            return;
                        }

                        if (_.has(parameter, 'schema') && _.isString(parameter.schema.$ref)) {
                            parameter.type = that.camelCase(that.getRefType(parameter.schema.$ref));
                        }

                        parameter.camelCaseName = that.camelCase(parameter.name);
                        // that.LogMessage('parameter ' + parameter.name);

                        // lets also check for a bunch of Java objects!
                        if (parameter.type === 'integer' || parameter.type === 'double' || parameter.type == 'Integer') {
                            parameter.typescriptType = 'number';
                        } else if (parameter.type == 'String') {
                            parameter.typescriptType = 'string';
                        } else if (parameter.type == 'Boolean') {
                            parameter.typescriptType = 'boolean';
                        } else if (parameter.type === 'object') {
                            parameter.typescriptType = 'any';
                        } else if (parameter.type === 'array') {
                            parameter.typescriptType = that.camelCase(parameter.items['type']) + '[]';
                            parameter.isArray = true;
                        } else if (parameter.schema && parameter.schema.type === 'array') {
                            var typeName = parameter.schema.items['type'] || parameter.schema.items['$ref'].replace('#/definitions/', '');
                            parameter.typescriptType = that.camelCase(typeName) + '[]';
                            parameter.isArray = true;
                        } else if (!parameter.type) {
                            parameter.typescriptType = 'any';
                        } else {
                            parameter.typescriptType = that.camelCase(parameter.type);
                        }

                        if (parameter.enum && parameter.enum.length === 1) {
                            parameter.isSingleton = true;
                            parameter.singleton = parameter.enum[0];
                        }

                        if (parameter.in === 'body') {
                            parameter.isBodyParameter = true;
                            method.hasBodyParameters = true;
                        } else if (parameter.in === 'path') {
                            parameter.isPathParameter = true;
                        } else if (parameter.in === 'query' || parameter.in === 'modelbinding') {
                            parameter.isQueryParameter = true;
                            if (parameter['x-name-pattern']) {
                                parameter.isPatternType = true;
                            }
                        } else if (parameter.in === 'header') {
                            parameter.isHeaderParameter = true;
                        } else if (parameter.in === 'formData') {
                            parameter.isFormParameter = true;
                        }

                        method.parameters.push(parameter);
                    });

                    if (method.parameters.length > 0) {
                        method.hasParameters = true;
                        method.parameters[method.parameters.length - 1].last = true;
                    }

                    if (op.responses['200'] != undefined) {
                        var responseSchema = op.responses['200'].schema;

                        if (_.has(responseSchema, 'type')) {
                            if (responseSchema['type'] === 'array') {
                                var items = responseSchema.items;
                                if (_.has(items, '$ref')) {
                                    method.response = that.camelCase(items['$ref'].replace('#/definitions/', '')) + '[]';
                                } else {
                                    var typescriptType;
                                    if (items['type'] === 'integer' || items['type'] === 'double') {
                                        typescriptType = 'number';
                                    }
                                    else {
                                        typescriptType = that.camelCase(items['type']);
                                    }
                                    method.response = typescriptType + '[]';
                                }
                            } else {
                                method.response = 'any';
                            }
                        } else if (_.has(responseSchema, '$ref')) {
                            method.response = that.camelCase(responseSchema['$ref'].replace('#/definitions/', ''));
                        } else {
                            method.response = 'any';
                        }
                    } else { // check non-200 response codes
                        method.response = 'any';
                    }

                    tag.methods.push(method);
                });
            });
        });

        _.forEach(swagger.definitions, function (defin, defVal) {
            var defName = that.camelCase(defVal);

            var definition = {
                name: defName,
                properties: [],
                refs: [],
                imports: []
            };

            // lower keyword to templates
            definition.lower = function () {
                return function (text, render) {
                    return render(text).toLowerCase();
                }
            };

            _.forEach(defin.properties, function (propin, propVal) {

                var property = {
                    name: propVal,
                    isRef: _.has(propin, '$ref') || (propin.type === 'array' && _.has(propin.items, '$ref')),
                    isArray: propin.type === 'array',
                    type: null,
                    typescriptType: null
                };

                if (property.isArray)
                    if (_.has(propin.items, '$ref')) {
                        property.type = that.camelCase(propin.items['$ref'].replace('#/definitions/', ''));
                    } else if (_.has(propin.items, 'type')) {
                        property.type = that.camelCase(propin.items['type']);
                    } else {
                        property.type = propin.type;
                    }

                else {
                    property.type = _.has(propin, '$ref') ? that.camelCase(propin['$ref'].replace('#/definitions/', '')) : propin.type;
                }

                if (property.type === 'integer' || property.type === 'double') {
                    property.typescriptType = 'number';
                } else if (property.type === 'object') {
                    property.typescriptType = 'any';
                } else if (property.name.slice(-2) === 'Yn') {
                    // app-custom logic - oracle doesn't have boolean types, so our variable naming convention is to have booleans
                    // end in Yn.  (activeYn, roleAssignedYn, etc).
                    property.typescriptType = 'boolean';
                } else if (['allowUpdate', 'allowDelete', 'allowInsert'].indexOf(property.name) >= 0) {
                    // app-custom logic. we have a couple properties that are persisted as strings, but the UI treats them as booleans.
                    property.typescriptType = 'boolean';
                } else {
                    property.typescriptType = property.type;
                }


                if (property.isRef) {
                    definition.refs.push(property);

                    // Don't duplicate import statements
                    var addImport = true;
                    for (var i = 0; i < definition.imports.length; i++) {
                        if (definition.imports[i] === property.type) {
                            addImport = false;
                        }
                    }
                    if (addImport) {
                        definition.imports.push(property.type);
                    }
                }
                else {
                    definition.properties.push(property);
                }
            });

            data.definitions.push(definition);
        });

        if (data.definitions.length > 0) {
            data.definitions[data.definitions.length - 1].last = true;
        }

        return data;
    };

    Generator.prototype.getRefType = function (refString) {
        var segments = refString.split('/');
        return segments.length === 3 ? segments[2] : segments[0];
    };

    Generator.prototype.getPathToMethodName = function (m, path) {
        if (path === '/' || path === '') {
            return m;
        }

        // clean url path for requests ending with '/'
        var cleanPath = path;

        if (cleanPath.indexOf('/', cleanPath.length - 1) !== -1) {
            cleanPath = cleanPath.substring(0, cleanPath.length - 1);
        }

        var segments = cleanPath.split('/').slice(1);

        segments = _.transform(segments, function (result, segment) {
            if (segment[0] === '{' && segment[segment.length - 1] === '}') {
                segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
            }

            result.push(segment);
        });

        var result = this.camelCase(segments.join('-'));

        return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
    };


    Generator.prototype.camelCase = function (text) {
        if (!text) {
            return text;
        }

        if (text.indexOf('-') === -1 && text.indexOf('.') === -1) {
            return text;
        }

        var tokens = [];

        text.split('-').forEach(function (token, index) {
            tokens.push((index > 0 ? token[0].toUpperCase() : token[0]) + token.substring(1));
        });

        var partialres = tokens.join('');
        tokens = [];

        partialres.split('.').forEach(function (token, index) {
            tokens.push((index > 0 ? token[0].toUpperCase() : token[0]) + token.substring(1));
        });

        return tokens.join('');
    };

    Generator.prototype.LogMessage = function (text, param) {
        if (this.Debug) {
            console.log(text, param || '');
        }
    };

    return Generator;
})();

module.exports.Generator = Generator;