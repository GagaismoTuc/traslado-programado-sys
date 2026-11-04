FROM node:24.22.1-slim
COPY deploy/tests/mock-osrm.mjs /mock-osrm.mjs
USER node
EXPOSE 5000
CMD ["node", "/mock-osrm.mjs"]
