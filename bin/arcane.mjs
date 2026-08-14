#!/usr/bin/env node

import {runCli} from '../src/cli/main.mjs';

process.exitCode=await runCli();
