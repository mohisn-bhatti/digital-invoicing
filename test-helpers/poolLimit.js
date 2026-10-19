// Preloaded into every test process (see "test" in package.json): each process, and each server a test starts, opens at most a few database
// connections. Left alone, Prisma opens up to twice the number of CPUs plus one per process, and a whole run overflows the 100 connections
// of the local database ("too many clients already"), which shows up as tests failing for no reason. (The environment is inherited by the
// servers the tests start, and dotenv never replaces a variable that is already set.)
require('dotenv').config({ quiet: true });
const url = process.env.DATABASE_URL;
if (url && !/[?&]connection_limit=/.test(url)) process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}connection_limit=4`;
