import { Context, Effect, Layer, Schema, type Scope } from "effect";
import { makeDimple, type Dimple } from "@ponraaj/dimple-sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DimpleError, SearchResponse, type SearchHit } from "./domain.ts";

export interface Unit {
  readonly logicalKey: string;
  readonly content: string;
  readonly metadata: string;
}

export interface WriteOptions {
  readonly embed?: boolean;
}

export interface Connection {
  readonly writeMany: (
    units: readonly Unit[],
    options?: WriteOptions,
  ) => Effect.Effect<void, DimpleError>;
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<{ readonly hits: readonly SearchHit[]; readonly ms: number }, DimpleError>;
}

export interface Interface {
  readonly version: () => Effect.Effect<string, DimpleError>;
  readonly connect: (options: {
    readonly configPath: string;
  }) => Effect.Effect<Connection, DimpleError, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()("@bench/DimpleSdk") {}

const sdkPackagePath = join(
  import.meta.dir,
  "..",
  "node_modules",
  "@ponraaj",
  "dimple-sdk",
  "package.json",
);

export const layer = Layer.succeed(
  Service,
  Service.of({
    version: Effect.fn("DimpleSdk.version")(function* () {
      return yield* Effect.try({
        try: () =>
          (JSON.parse(readFileSync(sdkPackagePath, "utf8")) as { version: string }).version,
        catch: (cause) => new DimpleError({ message: `sdk version: ${String(cause)}` }),
      });
    }),
    connect: Effect.fn("DimpleSdk.connect")(function* (options) {
      const dimple: Dimple = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => makeDimple({ config: options.configPath }),
          catch: (cause) => new DimpleError({ message: `sdk boot: ${String(cause)}` }),
        }),
        (handle) =>
          Effect.tryPromise({
            try: () => handle.dispose(),
            catch: (cause) => new DimpleError({ message: `sdk dispose: ${String(cause)}` }),
          }).pipe(Effect.orDie),
      );

      const writeMany = Effect.fn("DimpleSdk.writeMany")(function* (
        units: readonly Unit[],
        options?: WriteOptions,
      ) {
        if (units.length === 0) return;
        yield* Effect.tryPromise({
          try: () =>
            dimple.writeMany(
              units.map((unit) => ({
                logicalKey: unit.logicalKey,
                content: unit.content,
                metadata: unit.metadata,
              })),
              options,
            ),
          catch: (cause) => new DimpleError({ message: `writeMany: ${String(cause)}` }),
        });
      });

      const search = Effect.fn("DimpleSdk.search")(function* (query: string, limit: number) {
        const started = performance.now();
        const rows = yield* Effect.tryPromise({
          try: () => dimple.query(query, { limit }),
          catch: (cause) => new DimpleError({ message: `query: ${String(cause)}` }),
        });
        const ms = performance.now() - started;
        const decoded = yield* Schema.decodeUnknownEffect(SearchResponse)({ results: rows }).pipe(
          Effect.mapError((cause) => new DimpleError({ message: `query decode: ${String(cause)}` })),
        );
        return { hits: decoded.results, ms };
      });

      return { writeMany, search };
    }),
  }),
);
