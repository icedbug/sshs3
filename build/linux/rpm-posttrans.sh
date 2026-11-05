#!/bin/bash

# Runs once at the very end of the RPM transaction, after every %postun. Upgrading from a release
# whose own after-remove script lacks the upgrade guard (see rpm-after-remove.sh) still removes the
# /usr/bin link after this package's %post created it; recreate it here. Idempotent, and a no-op
# when the app is not installed.
#
# The names are written out on purpose: fpm passes --rpm-posttrans files through as they are, so
# the ${executable} / ${sanitizedProductName} substitution that electron-builder applies to
# after-install / after-remove does not happen here. Keep in step with productName in
# electron-builder.json if it is ever renamed.
if [ -x /opt/sshs3/sshs3 ]; then
    if type update-alternatives >/dev/null 2>&1; then
        update-alternatives --install /usr/bin/sshs3 sshs3 /opt/sshs3/sshs3 100 || ln -sf /opt/sshs3/sshs3 /usr/bin/sshs3
    else
        ln -sf /opt/sshs3/sshs3 /usr/bin/sshs3
    fi
fi
