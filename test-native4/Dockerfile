ARG PG_IMAGE
FROM ${PG_IMAGE}
RUN . /etc/os-release && test "$VERSION_CODENAME" = trixie \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends --no-upgrade \
 libatomic1=14.2.0-19 ca-certificates=20250419+deb13u1 openssl python3 \
 && rm -rf /var/lib/apt/lists/*
