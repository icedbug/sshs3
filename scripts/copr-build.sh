#!/usr/bin/env bash
#
# Builds a published sshs3 release in Fedora COPR (https://copr.fedorainfracloud.org/coprs/alun-hub/sshs3/).
# Called by deploy.sh after a release, and runnable on its own (`npm run copr`), for example to retry:
#
#   ./scripts/copr-build.sh [--dry-run] [--tag vX.Y.Z] [--release N] [--no-wait-release]
#
# The COPR package repackages the RPM from the GitHub release (packaging/copr/sshs3.spec), so this
# waits for the release workflow to publish it. What it does, in order (any failure stops here and
# nothing is uploaded to COPR):
#   1. Check the prerequisites: gh logged in, copr-cli with a valid token, rpmbuild.
#   2. Wait until the release for the tag is published with its RPM and SHA256SUMS
#      (--no-wait-release: fail instead of waiting).
#   3. Download both into a fresh temporary directory and verify the RPM: its SHA-256 against the
#      release's SHA256SUMS and its build-provenance attestation (gh attestation verify). The
#      attestation is what proves where the file came from; the checksum file ships in the same release.
#   4. Render the spec in the temporary directory (Version, Release, source_sha256, %changelog;
#      the committed spec is not touched) and build a source RPM. Nothing from the RPM is executed.
#   5. `copr-cli build`, wait for the result and print the build URL.
#
# --dry-run only does step 1 and prints what would happen. --release N raises the package release
# (default 1) when the same version has to be built again.
#
# Environment: SSHS3_COPR_PROJECT (default alun-hub/sshs3), SSHS3_GH_REPO (default alun-hub/sshs3),
#              SSHS3_COPR_WAIT_MINUTES (default 45): how long to wait for the release to appear.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$REPO_ROOT/packaging/copr/sshs3.spec"
COPR_PROJECT="${SSHS3_COPR_PROJECT:-alun-hub/sshs3}"
GH_REPO="${SSHS3_GH_REPO:-alun-hub/sshs3}"
WAIT_MINUTES="${SSHS3_COPR_WAIT_MINUTES:-45}"
COPR_CONFIG="${HOME}/.config/copr"
DRY_RUN=false
WAIT_RELEASE=true
TAG=""
RELEASE=1

YELLOW="\033[0;33m"; GREEN="\033[0;32m"; CYAN="\033[0;36m"; RED="\033[0;31m"; RESET="\033[0m"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --tag|--release)
      [[ $# -ge 2 ]] || { echo -e "${RED}$1 needs a value.${RESET}" >&2; exit 2; }
      if [[ "$1" == "--tag" ]]; then TAG="$2"; else RELEASE="$2"; fi
      shift 2
      ;;
    --no-wait-release) WAIT_RELEASE=false; shift ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo -e "${RED}Unknown option: $1${RESET}" >&2; exit 2 ;;
  esac
done

fail() { echo -e "${RED}copr: $*${RESET}" >&2; exit 1; }
info() { echo -e "${CYAN}copr: $*${RESET}"; }

[[ "$RELEASE" =~ ^[1-9][0-9]*$ ]] || fail "--release must be a positive whole number (got '${RELEASE}')."
[[ "$WAIT_MINUTES" =~ ^[1-9][0-9]*$ ]] || fail "SSHS3_COPR_WAIT_MINUTES must be a positive whole number."
[[ -f "$SPEC" ]] || fail "spec not found: ${SPEC}"

# 1. Prerequisites.
for tool in gh copr-cli rpmbuild node sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || fail "'${tool}' is not installed."
done
gh auth status >/dev/null 2>&1 || fail "the gh CLI is not logged in (gh auth login)."
gh repo view "$GH_REPO" --json name >/dev/null 2>&1 || fail "cannot read the GitHub repository ${GH_REPO} (check SSHS3_GH_REPO and gh access)."
# copr-cli finds its config itself ($COPR_CONFIG, ~/.config/copr or /etc/copr.conf), so authentication is the check.
copr-cli whoami >/dev/null 2>&1 || fail "copr-cli cannot authenticate; create or renew the token at https://copr.fedorainfracloud.org/api/ and save it in ${COPR_CONFIG}."

# The API page writes "# expiration date: YYYY-MM-DD" into the config; warn well before it runs out.
expiry=""
[[ -f "$COPR_CONFIG" ]] && expiry="$(sed -n 's/^# expiration date: \([0-9-]\{10\}\).*/\1/p' "$COPR_CONFIG" | head -n1)"
if [[ -n "$expiry" ]] && expiry_epoch="$(date -d "$expiry" +%s 2>/dev/null)"; then
  days_left=$(( (expiry_epoch - $(date +%s)) / 86400 ))
  if (( days_left < 30 )); then
    echo -e "${YELLOW}copr: the COPR token expires in ${days_left} day(s) (${expiry}); renew it at https://copr.fedorainfracloud.org/api/${RESET}"
  fi
fi

# Tag: default to the highest vX.Y.Z (not just the newest one reachable from HEAD), and never let
# anything but vX.Y.Z reach paths or the spec.
if [[ -z "$TAG" ]]; then
  TAG="$(git -C "$REPO_ROOT" tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname 2>/dev/null | head -n1 || true)"
fi
node "$REPO_ROOT/scripts/copr-spec.mjs" valid-tag "$TAG" || fail "'${TAG}' is not a release tag of the form vX.Y.Z."
VERSION="${TAG#v}"
RPM_NAME="sshs3-${VERSION}.x86_64.rpm"

if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${YELLOW}[DRY RUN] Would, for ${TAG} (package release ${RELEASE}):${RESET}"
  echo "  1. wait for the GitHub release ${TAG} to be published with ${RPM_NAME} and SHA256SUMS (up to ${WAIT_MINUTES} min)"
  echo "  2. download them to a temporary directory; verify the SHA-256 and the build-provenance attestation"
  echo "  3. render ${SPEC#"$REPO_ROOT"/} (Version ${VERSION}, Release ${RELEASE}) and build a source RPM"
  echo "  4. copr-cli build ${COPR_PROJECT} <srpm>"
  echo -e "${GREEN}✓ Dry run complete. Prerequisites are in place; nothing was downloaded or uploaded.${RESET}"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# An interrupt must look like one to deploy.sh (exit 130). Once the upload has started the COPR build
# keeps running on the server, so say where to find it instead of suggesting a duplicate build.
trap 'echo >&2; echo "copr: interrupted. A COPR build that was already uploaded keeps running: https://copr.fedorainfracloud.org/coprs/${COPR_PROJECT}/builds/" >&2; exit 130' INT
mkdir -p "$WORK/dl" "$WORK/spec" "$WORK/rpmbuild"

# 2. Wait for the release workflow to publish the RPM.
# Names of the fully uploaded assets of a published (non-draft) release, one per line. Returns 1 when the
# release does not exist yet (keep waiting) and 2, with gh's message, on any other error (auth, network...).
release_assets() {
  local out
  if ! out="$(gh release view "$TAG" --repo "$GH_REPO" --json isDraft,assets \
      --jq 'if .isDraft then empty else .assets[] | select(.state == "uploaded") | .name end' 2>&1)"; then
    [[ "$out" == *"release not found"* ]] && return 1
    printf '%s\n' "$out"
    return 2
  fi
  printf '%s\n' "$out"
}
release_ready() {
  local names rc=0
  names="$(release_assets)" || rc=$?
  if (( rc == 2 )); then fail "gh release view failed: ${names}"; fi
  (( rc == 0 )) || return 1
  grep -qxF "$RPM_NAME" <<<"$names" && grep -qxF "SHA256SUMS" <<<"$names"
}
info "waiting for release ${TAG} (${RPM_NAME}) on ${GH_REPO}..."
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
until release_ready; do
  if [[ "$WAIT_RELEASE" != "true" ]]; then
    fail "release ${TAG} is not published with ${RPM_NAME} yet (rerun without --no-wait-release to wait)."
  fi
  (( $(date +%s) < deadline )) || fail "release ${TAG} was not published within ${WAIT_MINUTES} minutes; check https://github.com/${GH_REPO}/actions and rerun \`npm run copr -- --tag ${TAG}\`."
  sleep 30
done
info "release ${TAG} is published."

# 3. Download and verify.
gh release download "$TAG" --repo "$GH_REPO" --pattern "$RPM_NAME" --pattern SHA256SUMS --dir "$WORK/dl" \
  || fail "could not download ${RPM_NAME} and SHA256SUMS from ${TAG}."
[[ -f "$WORK/dl/$RPM_NAME" && -f "$WORK/dl/SHA256SUMS" ]] || fail "the release is missing ${RPM_NAME} or SHA256SUMS."

SHA256="$(awk -v f="$RPM_NAME" '$2 == f { print $1 }' "$WORK/dl/SHA256SUMS")"
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "SHA256SUMS has no single valid entry for ${RPM_NAME}."
echo "${SHA256}  ${RPM_NAME}" | (cd "$WORK/dl" && sha256sum -c --quiet -) || fail "checksum mismatch for ${RPM_NAME}."
# Only an attestation made by this repository's release workflow counts, not any workflow in the repo.
if ! attestation_out="$(gh attestation verify "$WORK/dl/$RPM_NAME" --repo "$GH_REPO" \
    --signer-workflow "${GH_REPO}/.github/workflows/release.yml" 2>&1)"; then
  fail "build-provenance attestation for ${RPM_NAME} could not be verified:"$'\n'"${attestation_out}"
fi
info "${RPM_NAME}: checksum and attestation verified."

# 4. Spec and source RPM.
node "$REPO_ROOT/scripts/copr-spec.mjs" render --spec "$SPEC" --version "$VERSION" --sha256 "$SHA256" \
  --release "$RELEASE" --out "$WORK/spec/sshs3.spec" || fail "could not render the spec."
rpmbuild -bs --define "_topdir $WORK/rpmbuild" --define "_sourcedir $WORK/dl" "$WORK/spec/sshs3.spec" >/dev/null \
  || fail "rpmbuild could not create the source RPM."
SRPM="$(find "$WORK/rpmbuild/SRPMS" -maxdepth 1 -name 'sshs3-*.src.rpm' | head -n1)"
[[ -n "$SRPM" ]] || fail "no source RPM was produced."
info "built $(basename "$SRPM"); uploading to COPR project ${COPR_PROJECT}..."

# 5. COPR build (copr-cli waits for the result and exits non-zero if the build fails).
copr-cli build "$COPR_PROJECT" "$SRPM" || fail "the COPR build failed (see the link above)."
echo -e "${GREEN}✓ COPR build of ${VERSION} succeeded: https://copr.fedorainfracloud.org/coprs/${COPR_PROJECT}/${RESET}"
