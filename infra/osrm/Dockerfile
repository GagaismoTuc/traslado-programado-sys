# Serving image: the OSRM artifact. Build context = the directory written by build.sh.
ARG OSRM_IMAGE
FROM ${OSRM_IMAGE}
COPY data/ /data/
COPY --chmod=755 serve.sh /usr/local/bin/serve-osrm
EXPOSE 5000
ENTRYPOINT ["/usr/local/bin/serve-osrm"]
