// Standalone worker that reads every X.509 certificate object off a PKCS#11 token and prints
// their raw DER bytes (base64) to stdout as JSON, then exits.
//
// Why this runs as a separate process instead of inline in SmartcardCertificateReader.ts: some
// vendor PKCS#11 modules (observed with Net iD's libiidp11.so) raise SIGTRAP inside C_Finalize()
// when loaded a second time in the same process that already has another PKCS#11 session open
// against the token (e.g. the app-lifetime agent loaded via `ssh-add -s` for 'agent-global' mode).
// That's a native crash — no amount of JS try/catch around C_Finalize can catch it, and it takes
// down the whole Electron main process. Running the read in a short-lived child process means a
// crash here only kills this worker; the caller (getOrLoadGlobalSmartcardAgent) treats a dead
// worker the same as "no certificate details available" and carries on.
//
// Invoked as: ELECTRON_RUN_AS_NODE=1 <electron-binary> certWorker.cjs <pkcs11LibPath>
// Prints exactly one line of JSON to stdout: {"certs":["<base64 DER>", ...],"tokenPresent":bool} on success,
// or {"error":"..."} on failure. Never throws past top level — always exits 0 with best-effort
// output, since the caller only cares whether it got certs or not.

const pkcs11js = require('pkcs11js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCertificatesFromSlot(pkcs11, slot, derList) {
  let session;
  try {
    session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_SERIAL_SESSION);
    pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE }]);
    const objects = pkcs11.C_FindObjects(session, 10);
    pkcs11.C_FindObjectsFinal(session);

    for (const obj of objects) {
      try {
        const attrs = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_VALUE }]);
        const der = attrs[0] && attrs[0].value;
        if (der && der.length > 0) {
          derList.push(Buffer.from(der).toString('base64'));
        }
      } catch {
        // Skip unreadable objects — best-effort.
      }
    }
    return { attempted: true, objectCount: objects.length };
  } catch (err) {
    return { attempted: true, objectCount: 0, error: err };
  } finally {
    if (session !== undefined) {
      try {
        pkcs11.C_CloseSession(session);
      } catch {
        // Ignore — done with this session either way.
      }
    }
  }
}

async function runCertWorker(argv = process.argv.slice(2), stdout = process.stdout, Pkcs11Class = pkcs11js.PKCS11) {
  const pkcs11LibPath = argv[0];
  const derList = [];

  if (!pkcs11LibPath) {
    stdout.write(JSON.stringify({ error: 'missing pkcs11LibPath argument' }) + '\n');
    return;
  }

  const pkcs11 = new Pkcs11Class();
  try {
    pkcs11.load(pkcs11LibPath);
    pkcs11.C_Initialize();
  } catch (err) {
    stdout.write(JSON.stringify({ error: String((err && err.message) || err) }) + '\n');
    return;
  }

  let slots;
  try {
    slots = pkcs11.C_GetSlotList(true);
  } catch (err) {
    stdout.write(JSON.stringify({ error: String((err && err.message) || err) }) + '\n');
    return;
  }

  for (const slot of slots) {
    const found = readCertificatesFromSlot(pkcs11, slot, derList);
    if (!found.attempted) continue;
    if (found.objectCount === 0 && found.error) {
      await sleep(300);
      readCertificatesFromSlot(pkcs11, slot, derList);
    }
  }

  // Write the result BEFORE calling C_Finalize below: C_Finalize is exactly the call observed
  // to SIGTRAP in the vendor module this worker exists to isolate, so the certs we already found
  // must reach the parent process over the stdout pipe first. If Finalize then crashes the
  // worker, that's fine — the parent only reads this one line and doesn't care how the worker's
  // process itself ends.
  stdout.write(JSON.stringify({ certs: derList, tokenPresent: slots.length > 0 }) + '\n');

  try {
    pkcs11.C_Finalize();
  } catch {
    // Isolated crash, if any — see comment above.
  }
}

if (require.main === module) {
  runCertWorker().catch((err) => {
    try {
      process.stdout.write(JSON.stringify({ error: String((err && err.message) || err) }) + '\n');
    } catch {
      // stdout unavailable — nothing more we can do.
    }
  });
}

module.exports = { runCertWorker, readCertificatesFromSlot };
