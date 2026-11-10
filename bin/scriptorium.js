#!/usr/bin/env node
'use strict';

require('../src/cli')
  .main()
  .then(() => {
    // Native modules can keep handles open after their work is done.
    process.exit(process.exitCode ?? 0);
  });
