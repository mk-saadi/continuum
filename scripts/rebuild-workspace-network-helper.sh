#!/bin/sh
# Run ONLY in the disposable Ubuntu rootfs described in the G.4 report.
# This builds a review candidate, never updates the shipping helper pin.
set -eu
test "$(id -u)" = 0
test -f /build/slirp4netns-source.tar.gz
test -f /build/libslirp-source.tar.gz
cd /build
export SOURCE_DATE_EPOCH=1793371908
export LC_ALL=C TZ=UTC
mkdir libslirp slirp4netns materials
tar -xzf libslirp-source.tar.gz -C libslirp --strip-components=1
tar -xzf slirp4netns-source.tar.gz -C slirp4netns --strip-components=1
dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' > materials/packages.tsv
cp /etc/apt/sources.list materials/sources.list
cc --version > materials/compiler.txt
ld --version > materials/linker.txt
meson setup --default-library=both --prefix=/usr/local libslirp/build libslirp
ninja -C libslirp/build -v
ninja -C libslirp/build install
export PKG_CONFIG_PATH=/usr/local/lib/x86_64-linux-gnu/pkgconfig
pkg-config --static --libs glib-2.0 slirp libcap libseccomp > materials/pkg-config-static.txt
cd slirp4netns
./autogen.sh
# Record the actual archive/object closure, not the --version banner.
./configure LDFLAGS='-static -Wl,-Map,/build/materials/slirp4netns.map,--cref -Wl,-t' --host=x86_64-linux-gnu
make V=1
cp slirp4netns /build/materials/slirp4netns.unstripped
cp slirp4netns /build/materials/slirp4netns
strip /build/materials/slirp4netns
cp config.log config.status Makefile /build/materials/
/build/materials/slirp4netns --version > /build/materials/version.txt
cd /build
# Preserve the object files and generated inputs for a reviewer/relink workflow.
tar -czf materials/build-trees.tar.gz libslirp slirp4netns
sha256sum materials/slirp4netns materials/slirp4netns.unstripped > materials/binary-SHA256SUMS
