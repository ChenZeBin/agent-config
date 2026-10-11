#!/usr/bin/env node
import { main } from '../../link-archive/scripts/link-archive.mjs';
process.exitCode = await main();
