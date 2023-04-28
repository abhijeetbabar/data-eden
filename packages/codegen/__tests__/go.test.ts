import { athenaCodegen } from '../src';
import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { buildSchema, parse } from 'graphql';

describe('it works', () => {
  test('it works', async () => {
    // const rawSchema = await fs.readFile(
    //   path.resolve('./__tests__/fixtures/schema.graphql'),
    //   'utf-8'
    // );

    // const op = await fs.readFile(
    //   path.resolve('./__tests__/fixtures/operation.graphql'),
    //   'utf-8'
    // );

    await athenaCodegen({
      schema: './__tests__/fixtures/schema.graphql',
      filePattern: '**/*.graphql',
      extension: '.ts',
    });

    expect(true);
  });
});
