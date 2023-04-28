// export type FindUserQueryVariables = Exact<{
//   userId: Scalars['ID'];
// }>;

// export type FindUserQuery = {
//   __typename?: 'Query';
//   user?: {
//     __typename?: 'User';
//     id: string;
//     username: string;
//     role: Role;
//   } | null;
// };

// export type UserFieldsFragment = {
//   __typename?: 'User';
//   id: string;
//   username: string;
//   role: Role;
// };

// Option 1
// each emitted file imports some kind of registerQuery function exported from Athena that registers
// the query and associates it with the metadata and then stores it in some kind of registry
// that way the actual generated file only contains an opaque token
// The registry is only populated when this file is imported (since it causes registerQuery to be invoked on import)
// Also store query metadata in registry
// - relationship structure (for use by parseEntities)
// - consider supporting Directives -> basically store off whatever directives are present in the query

/**
 * registerQuery(moduleId?, some query string): POJO that we actual export
 *
 * POJO would have $DEBUG prop that shows the query, file path, module id, whatever
 * this POJO would serve as the key in the WeakMap used in the registry
 */

// Query metadata

// Option 2
/**
 * *always* compute the query hash and consume it in both dev and prod. Still ahve registerQuery, still have $DEBUG
 * Has the advantage of prod and dev executing the same query
 * But now you have a massive file that maps hashes to query strings, which can be a huge pain on rebuilds (can't rebuild the entire map at once)
 * Might solve this by mapping to directory structure instead of one giant flattened map
 * data eden cache accepts a registry that is a mapping of keys to types. this option would take advantage of that
 */
