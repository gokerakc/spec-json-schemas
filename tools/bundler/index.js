const path = require('path');
const fs = require('fs');
const traverse = require('json-schema-traverse');
const definitionsDirectory = path.resolve(__dirname, '../../definitions');
const bindingsDirectory = path.resolve(__dirname, '../../bindings');
const outputDirectory = path.resolve(__dirname, '../../schemas');
const JSON_SCHEMA_PROP_NAME = 'json-schema-draft-07-schema';
console.log(`Looking for separate definitions in the following directory: ${definitionsDirectory}`);
console.log(`Looking for binding version schemas in the following directory: ${bindingsDirectory}`);
console.log(`Using the following output directory: ${outputDirectory}`);

// definitionsRegex is used to transform the name of a definition into a valid one to be used in the -without-$id.json files.
const definitionsRegex = /http:\/\/asyncapi\.com\/definitions\/[^/]*\/(.+)\.json#?(.*)/i;

// definitionsRegex is used to transform the name of a binding into a valid one to be used in the -without-$id.json files.
const bindingsRegex = /http:\/\/asyncapi\.com\/(bindings\/[^/]+)\/([^/]+)\/(.+)\.json(.*)/i;

/**
 * Function to load all the core AsyncAPI spec definition (except the root asyncapi schema, as that will be loaded later) into the bundler.
 */
async function loadDefinitions(bundler, versionDir) {
  const definitions = await fs.promises.readdir(versionDir);
  const definitionFiles = definitions.filter((value) => {return !value.includes('asyncapi');}).map((file) => fs.readFileSync(path.resolve(versionDir, file)));
  const definitionJson = definitionFiles.map((file) => JSON.parse(file));
  for (const jsonFile of definitionJson) {
    if (jsonFile.example) {
      // Replaced the example property with the referenced example property
      const examples = await loadRefProperties(jsonFile.example);
      // Replacing example property with examples is because using example
      // to pass an array of example properties is not valid in JSON Schema.
      // So replacing it when bundling is the goto solution. 
      jsonFile.examples = examples;
      delete jsonFile.example;
      bundler.add(jsonFile);
    } else {
      bundler.add(jsonFile);
    }
  }
}
/**
 * Function to load all the binding version schemas into the bundler
 */
async function loadBindings(bundler) {
  const bindingDirectories = await fs.promises.readdir(bindingsDirectory);
  for (const bindingDirectory of bindingDirectories) {
    const bindingVersionDirectories = await fs.promises.readdir(path.resolve(bindingsDirectory, bindingDirectory));
    const bindingVersionDirectoriesFiltered = bindingVersionDirectories.filter((file) => fs.lstatSync(path.resolve(bindingsDirectory, bindingDirectory, file)).isDirectory());
    for (const bindingVersionDirectory of bindingVersionDirectoriesFiltered) {
      const bindingFiles = await fs.promises.readdir(path.resolve(bindingsDirectory, bindingDirectory, bindingVersionDirectory));
      const bindingFilesFiltered = bindingFiles.filter((bindingFile) => path.extname(bindingFile) === '.json').map((bindingFile) => path.resolve(bindingsDirectory, bindingDirectory, bindingVersionDirectory, bindingFile));
      for (const bindingFile of bindingFilesFiltered) {
        const bindingFileContent = require(bindingFile);
        bundler.add(bindingFileContent);
      }
    }
  }
}
/**
 * When run, go through all versions that have split definitions and bundles them together.
 */
(async () => {
  const versions = await fs.promises.readdir(definitionsDirectory);
  console.log(`Ensuring output directory is present ${outputDirectory}`);
  if (!fs.existsSync(outputDirectory)) {
    await fs.promises.mkdir(outputDirectory);
  }
  console.log(`The following versions have separate definitions: ${versions.join(',')}`);
  for (const version of versions) {
    const Bundler = require('@hyperjump/json-schema-bundle');
    try {
      console.log(`Bundling the following version together: ${version}`);
      const outputFileWithId = path.resolve(outputDirectory, `${version}.json`);
      const outputFileWithoutId = path.resolve(outputDirectory, `${version}-without-$id.json`);
      const versionDir = path.resolve(definitionsDirectory, version);
      await loadDefinitions(Bundler, versionDir);
      await loadBindings(Bundler);

      const filePathToBundle = `file://${versionDir}/asyncapi.json`;
      const fileToBundle = await Bundler.get(filePathToBundle);

      /**
       * bundling schemas into one file with $id
       */
      const bundledSchemaWithId = await Bundler.bundle(fileToBundle);
      bundledSchemaWithId.description = `!!Auto generated!! \n Do not manually edit. ${bundledSchemaWithId.description !== undefined && bundledSchemaWithId.description !== null ? bundledSchemaWithId.description : ''}`;
      console.log(`Writing the bundled file WITH $ids to: ${outputFileWithId}`);
      await fs.promises.writeFile(outputFileWithId, JSON.stringify(bundledSchemaWithId, null, 4));

      /**
       * removing ids from schemas and making modifications in definitions name to make sure schemas still work
       * this is needed for tools that do not support $id feature in JSON Schema
       */
      const bundledSchemaWithoutIds = modifyRefsAndDefinitions(bundledSchemaWithId);
      console.log(`Writing the bundled file WITHOUT $ids to: ${outputFileWithoutId}`);
      await fs.promises.writeFile(outputFileWithoutId, JSON.stringify(bundledSchemaWithoutIds, null, 4));
    } catch (e) {
      throw new Error(e);
    }
  }
  console.log('done');
})();

/**
 * Extract file data from reference file path
 */

async function loadRefProperties(filePath) {
  const schemaPath = filePath.$ref;
  // first we need to turn the path to an absolute file path instead of a generic url
  const versionPath = schemaPath.split('examples')[1];
  // we append the extracted file path to the examples dir to read the file
  try {
    const data = await fs.promises.readFile(`../../examples${versionPath}`);
    return JSON.parse(data);
  } catch (e) {
    throw new Error(e);
  }
}

/**
 * we first update definitions from URL to normal names
 * than update refs to point to new definitions, always inline never remote
 */
function modifyRefsAndDefinitions(bundledSchema) {
  //first we need to improve names of the definitions from URL to their names
  for (const def of Object.keys(bundledSchema.definitions)) {
    const newDefName = getDefinitionName(def);
    
    //creating copy of definition under new name so later definition stored under URL name can be removed
    bundledSchema.definitions[newDefName] = bundledSchema.definitions[def];
    delete bundledSchema.definitions[def];
  }

  traverse(bundledSchema, replaceRef);
  traverse(bundledSchema.definitions.avroSchema_v1, updateAvro);
  traverse(bundledSchema.definitions.openapiSchema_3_0, updateOpenApi);
  traverse(bundledSchema.definitions['json-schema-draft-07-schema'], updateJsonSchema);

  return bundledSchema;
}

/**
 * by default schemas definition names are urls like http://asyncapi.com/definitions/2.4.0/parameters.json
 * we need to get rid of URLs and use the last fragment as new definition name like `parameters`
 */
function getDefinitionName(def) {
  if (def.startsWith('http://json-schema.org')) return JSON_SCHEMA_PROP_NAME;
  if (def.startsWith('http://asyncapi.com/definitions')) {
    const result = definitionsRegex.exec(def);
    if (result) return result[1].replace('/', '-') + result[2];
  }
  if (def.startsWith('http://asyncapi.com/bindings')) {
    const result = bindingsRegex.exec(def);
    if (result) return `${result[1].replace('/', '-')}-${result[2]}-${result[3]}`;
  }
  
  return path.basename(def, '.json');
}

/**
 * this is a callback used when traversing through json schema
 * it is triggered with every new element of json schema
 */
function replaceRef(schema) {
  //new refs will only work if we remove $id that all point to asyncapi.com
  delete schema.$id;
  
  //traversing shoudl take place only in case of schemas with refs
  if (schema.$ref === undefined) return;
  // updating refs that are related to remote URL refs that need to be update and point to inlined versions
  if (!schema.$ref.startsWith('#')) schema.$ref = `#/definitions/${getDefinitionName(schema.$ref)}`;
}

/**
 * this is a callback used when traversing through json schema
 * to fix avro schema definitions to point to right direction
 */
function updateAvro(schema) {
  //traversing shoudl take place only in case of schemas with refs
  if (schema.$ref === undefined) return;

  schema.$ref = schema.$ref.replace(
    /* eslint-disable sonarjs/no-duplicate-string */
    '#/definitions/',
    '#/definitions/avroSchema_v1/definitions/'
  );
}

/**
 * this is a callback used when traversing through json schema
 * to fix open api schema definitions to point to right direction
 */
function updateOpenApi(schema) {
  //traversing shoudl take place only in case of schemas with refs
  if (schema.$ref === undefined) return;
  const openApiPropName = 'openapiSchema_3_0';

  schema.$ref = schema.$ref.replace(
    '#/definitions/',
    `#/definitions/${openApiPropName}/definitions/`
  );

  if (schema.$ref === '#') {
    schema.$ref = `#/definitions/${openApiPropName}`;
  }
}

/**
 * this is a callback used when traversing through json schema
 * to fix open api schema definitions to point to right direction
 */
function updateJsonSchema(schema) {
  //traversing shoudl take place only in case of schemas with refs
  if (schema.$ref === undefined) return;

  schema.$ref = schema.$ref.replace(
    '#/definitions/',
    `#/definitions/${JSON_SCHEMA_PROP_NAME}/definitions/`
  );

  if (schema.$ref === '#') {
    schema.$ref = `#/definitions/${JSON_SCHEMA_PROP_NAME}`;
  }
}