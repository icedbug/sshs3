# Repackages the prebuilt sshs3 RPM from GitHub Releases for Fedora COPR.
#
# The release workflow already builds the app (electron-builder), so nothing is compiled
# here: %prep unpacks the released RPM and %install copies its payload into the buildroot.
# COPR build chroots have no network access, which is why a from-source build is not an option.
#
# Releases are built with scripts/copr-build.sh (npm run copr), which renders a copy of this file with the
# release's Version, Release, source_sha256 and a %changelog entry; the values below are only a valid
# example and need no editing per release.

%global source_sha256 0d4a18b976e5e02f7e70d0e2b93a39475aa305e6a58b72ab0e5ba501ee2262c1

# Prebuilt Electron payload: no debuginfo, no stripping/brp rewriting, no auto-generated
# requires/provides for the bundled libraries (the real Requires are listed below).
%global debug_package %{nil}
%global _build_id_links none
%global __os_install_post %{nil}
AutoReqProv: no

Name:           sshs3
Version:        0.96.59
Release:        1%{?dist}
Summary:        Modern SSH, SFTP, and S3 client with smartcard and drag-and-drop support

# sshs3 itself is MIT; the bundled Electron/Chromium components carry their own licenses
# (see /opt/sshs3/LICENSE.electron.txt and /opt/sshs3/LICENSES.chromium.html).
License:        MIT
URL:            https://github.com/alun-hub/sshs3
Source0:        %{url}/releases/download/v%{version}/sshs3-%{version}.x86_64.rpm

ExclusiveArch:  x86_64

BuildRequires:  rpm
BuildRequires:  cpio

# The upstream RPM's runtime dependencies, plus alsa-lib and mesa-libgbm (the app links libasound.so.2
# and libgbm.so.1) and hicolor-icon-theme (owner of the icon directories below). Auto-generated requires are off.
Requires:       alsa-lib
Requires:       at-spi2-core
Requires:       gtk3
Requires:       hicolor-icon-theme
Requires:       libXScrnSaver
Requires:       libXtst
Requires:       libnotify
Requires:       libuuid
Requires:       mesa-libgbm
Requires:       nss
Requires:       xdg-utils

%description
sshs3 is a modern, security-focused SSH, SFTP, S3, and Kubernetes client with
hardware security key and smartcard support (FIDO2, YubiKey, PKCS#11), split
terminals, and a dual-pane file manager.

This package repackages the official binary release from GitHub.

%prep
%setup -q -c -T
echo "%{source_sha256}  %{SOURCE0}" | sha256sum -c -
rpm2cpio %{SOURCE0} | cpio -idm --quiet

%build
# Nothing to build: the payload is prebuilt.

%install
mkdir -p %{buildroot}/opt %{buildroot}%{_datadir} %{buildroot}%{_bindir}
cp -a opt/sshs3 %{buildroot}/opt/
cp -a usr/share/applications usr/share/icons %{buildroot}%{_datadir}/
# The upstream package creates this link in a scriptlet that its own after-remove script deletes
# again on every upgrade; shipping it as a package file survives upgrades.
ln -s /opt/sshs3/sshs3 %{buildroot}%{_bindir}/sshs3

# File list for the app tree. chrome-sandbox is listed on its own below because its mode is
# decided in %%post.
(
  cd %{buildroot}
  find opt/sshs3 -type d -printf '%%%%dir /%%p\n'
  find opt/sshs3 ! -type d ! -name chrome-sandbox -printf '/%%p\n'
) > %{_builddir}/%{name}-%{version}/app.files

%files -f app.files
%verify(not mode) %attr(0755,root,root) /opt/sshs3/chrome-sandbox
%{_bindir}/sshs3
%{_datadir}/applications/sshs3.desktop
%{_datadir}/icons/hicolor/*/apps/sshs3.png

%post -p /bin/bash
# Same rule as the upstream package: use the SUID sandbox only where user namespaces do not work.
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    chmod 4755 /opt/sshs3/chrome-sandbox || true
fi

%posttrans
# When this package replaces the upstream RPM from GitHub Releases, that package's %postun runs
# after this one is installed and its update-alternatives --remove can delete /usr/bin/sshs3.
# %posttrans runs after every %postun, so put the link back if it is gone.
if [ -x /opt/sshs3/sshs3 ] && [ ! -e /usr/bin/sshs3 ]; then
    ln -s /opt/sshs3/sshs3 /usr/bin/sshs3
fi

%changelog
* Fri Oct 23 2026 Andreas Lundqvist <info@sshs3.com> - 0.96.58-1
- Initial COPR packaging of the prebuilt release; one entry per release is added on top by scripts/copr-build.sh
- Require alsa-lib and hicolor-icon-theme; recreate /usr/bin/sshs3 after replacing the upstream RPM
