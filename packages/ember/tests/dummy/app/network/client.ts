import { Entity } from '@data-eden/athena';
import { createClient } from '@data-eden/ember';

export const client = createClient({
  url: 'http://localhost:4000/graphql',
  id: (v: Entity) => `${v.__typename}:${v.id}`,
});
