// Deliberately crashes before completing the handshake.
process.stdout.write('starting\n');
process.stderr.write('crash fixture: refusing to start\n');
process.exit(3);
