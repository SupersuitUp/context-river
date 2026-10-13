import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../src/index.mjs";

test("the package loads", () => { assert.equal(VERSION, "0.1.0"); });
