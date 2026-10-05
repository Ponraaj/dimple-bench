import { Effect } from "effect";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { IoError } from "./domain.ts";

const io = <A>(label: string, run: () => A): Effect.Effect<A, IoError> =>
  Effect.try({
    try: run,
    catch: (cause) => new IoError({ message: `${label}: ${String(cause)}` }),
  });

export const readText = (path: string): Effect.Effect<string, IoError> =>
  io(`read ${path}`, () => readFileSync(path, "utf8"));

export const writeText = (path: string, content: string): Effect.Effect<void, IoError> =>
  io(`write ${path}`, () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  });

export const appendText = (path: string, content: string): Effect.Effect<void, IoError> =>
  io(`append ${path}`, () => appendFileSync(path, content));

export const writeJson = (path: string, value: unknown): Effect.Effect<void, IoError> =>
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);

export const appendJsonl = (path: string, value: unknown): Effect.Effect<void, IoError> =>
  appendText(path, `${JSON.stringify(value)}\n`);

export const exists = (path: string): boolean => existsSync(path);

export const removeDir = (path: string): Effect.Effect<void, IoError> =>
  io(`remove ${path}`, () => rmSync(path, { recursive: true, force: true }));

export const ensureDir = (path: string): Effect.Effect<void, IoError> =>
  io(`mkdir ${path}`, () => mkdirSync(path, { recursive: true }));
