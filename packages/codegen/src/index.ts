import { codegen } from '@graphql-codegen/core';
import type { Types } from '@graphql-codegen/plugin-helpers';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import * as typescriptOperationsPlugin from '@graphql-codegen/typescript-operations';
import { GraphQLFileLoader } from '@graphql-tools/graphql-file-loader';
import { loadDocuments } from '@graphql-tools/load';
import { readFile } from 'fs/promises';
import { globby } from 'globby';
import type { DocumentNode, GraphQLSchema } from 'graphql';
import { parse } from 'graphql';
import * as path from 'node:path';
import { extractImportLines, parseImportLine } from '@graphql-tools/import';

export interface Source {
  document?: DocumentNode;
  schema?: GraphQLSchema;
  rawSDL?: string;
  location?: string;
}

interface CodegenArgs {
  schema: string;
  filePattern: string;
  extension: string;
}

export async function athenaCodegen({
  schema,
  filePattern,
  extension,
}: CodegenArgs): Promise<void> {
  // Read schema
  const rawSchema = await readFile(schema, 'utf-8');
  const parsedSchema = parse(rawSchema);
  // const parsedSchema = await loadSchema(schema, {
  //   loaders: [new GraphQLFileLoader()],
  // });

  console.log('schema path', schema);

  // Generate schema types and write to root schema file

  const schemaTypes = await codegen({
    documents: [],
    config: {},
    // used by a plugin internally, although the 'typescript' plugin currently
    // returns the string output, rather than writing to a file
    filename: 'schema.d.ts',
    schema: parsedSchema,
    plugins: [
      {
        typescript: {}, // Here you can pass configuration to the plugin
      },
    ] as Array<Types.ConfiguredPlugin>,
    pluginMap: {
      typescript: typescriptPlugin,
    },
  });

  // console.log('schemaTypes', schemaTypes);

  // Expand glob patterns and find matching files
  const paths = await globby([filePattern, `!${schema}`]);
  console.log(path.basename(schema));
  console.log('paths', paths);

  // Read all documents and parse into DocumentNodes

  const documents = await loadDocuments(paths, {
    loaders: [new GraphQLFileLoader()],
  });

  // console.log('docs', documents);

  // Generate types for each document + import statements for Schema types

  const documentTypes = await Promise.all(
    documents.map(async (document) => {
      console.log(document);
      const importLines = extractImportLines(document.rawSDL!);
      console.log('importLines', importLines);
      const typeDef = await codegen({
        documents: [document],
        config: {},
        // used by a plugin internally, although the 'typescript' plugin currently
        // returns the string output, rather than writing to a file
        filename: 'operation.d.ts',
        schema: parsedSchema,
        plugins: [
          {
            typescriptOperations: {
              flattenGeneratedTypes: false,
              flattenGeneratedTypesIncludeFragments: false,
            },
          },
          // {
          //   typedDocumentNode: {
          //     flattenGeneratedTypes: false,
          //   },
          // },
        ] as Array<Types.ConfiguredPlugin>,
        pluginMap: {
          typescriptOperations: typescriptOperationsPlugin,
          // typedDocumentNode: typedDocumentNodePlugin,
        },
      });

      return {
        location: document.location!,
        typeDef,
      };
    })
  );

  documentTypes.forEach((t, i) => {
    console.log(`=============== ${t.location} ====================`);
    console.log(t.typeDef);
  });

  // Add `registerQuery` call to each document and export the result
}

// export async function go(rawSchema: string, documents: Array<Source> = []) {
//   const builtSchema: GraphQLSchema = buildSchema(rawSchema);
//   const schema = parse(printSchema(builtSchema));

//   const importStatements = resolveDocumentImports(
//     {
//       baseOutputDir: './types',
//       documents: documents,
//     },
//     schema,
//     {
//       baseDir: process.cwd(),
//     }
//   );

//   const configs: Array<Types.GenerateOptions> = [
//     {
//       documents: [],
//       config: {},
//       // used by a plugin internally, although the 'typescript' plugin currently
//       // returns the string output, rather than writing to a file
//       filename: 'schema.d.ts',
//       schema: schema,
//       plugins: [
//         {
//           typescript: {}, // Here you can pass configuration to the plugin
//         },
//       ] as Array<Types.ConfiguredPlugin>,
//       pluginMap: {
//         typescript: typescriptPlugin,
//       },
//     },
//     {
//       documents: documents,
//       config: {},
//       // used by a plugin internally, although the 'typescript' plugin currently
//       // returns the string output, rather than writing to a file
//       filename: 'operation.d.ts',
//       schema: schema,
//       plugins: [
//         {
//           typescriptOperations: {
//             flattenGeneratedTypes: false,
//             flattenGeneratedTypesIncludeFragments: false,
//           },
//         },
//         {
//           typedDocumentNode: {
//             flattenGeneratedTypes: false,
//           },
//         },
//       ] as Array<Types.ConfiguredPlugin>,
//       pluginMap: {
//         typescriptOperations: typescriptOperationsPlugin,
//         typedDocumentNode: typedDocumentNodePlugin,
//       },
//     },
//   ];

//   const outputs = await Promise.all(configs.map((config) => codegen(config)));

//   outputs.forEach((o, i) => {
//     console.log(`============ ${i} =================`);
//     console.log(o);
//   });
// }
