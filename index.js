/* Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

const {
  MeterProvider,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');
const {Resource} = require('@opentelemetry/resources');
const {
  MetricExporter: GcpMetricExporter,
} = require('@google-cloud/opentelemetry-cloud-monitoring-exporter');
const {GcpDetectorSync} = require('@google-cloud/opentelemetry-resource-util');
const Semconv = require('@opentelemetry/semantic-conventions');
const {logger} = require('./logger.js');
const functions = require('@google-cloud/functions-framework');



/**
 * @typedef {{
*    [x: string]: string,
* }} CounterAttributes
*/
/** @type {CounterAttributes} */
const RESOURCE_ATTRIBUTES = {
 [Semconv.SEMRESATTRS_SERVICE_NAMESPACE]: 'nielm',
 [Semconv.SEMRESATTRS_SERVICE_NAME]: 'counters-test',
 [Semconv.SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
};


let backgroundCounter;
let requestCounter;

async function initMetrics() {
  logger.debug('initializing metrics');

  if (process.env.KUBERNETES_SERVICE_HOST) {
    // In K8s. We need to set the Pod Name to prevent duplicate
    // timeseries errors.
    if (process.env.K8S_POD_NAME) {
      RESOURCE_ATTRIBUTES[Semconv.SEMRESATTRS_K8S_POD_NAME] =
        process.env.K8S_POD_NAME;
    } else {
      logger.warn(
        'WARNING: running under Kubernetes, but K8S_POD_NAME ' +
          'environment variable is not set. ' +
          'This may lead to Send TimeSeries errors',
      );
    }
  }

  const gcpResources = new GcpDetectorSync().detect();
  if (gcpResources.waitForAsyncAttributes) {
    await gcpResources.waitForAsyncAttributes();
  }

  if (process.env.FUNCTION_TARGET && process.env.USE_OTEL_GCF_WORKAROUND) {
    // In cloud functions.
    // We need to set the platform to generic_task so that the
    // function instance ID gets set in the  counter resource attributes.
    // For details, see
    // https://github.com/GoogleCloudPlatform/opentelemetry-operations-js/issues/679
    RESOURCE_ATTRIBUTES[Semconv.SEMRESATTRS_CLOUD_PLATFORM] = 'generic_task';

    if (gcpResources.attributes[Semconv.SEMRESATTRS_FAAS_ID]?.toString()) {
      RESOURCE_ATTRIBUTES[Semconv.SEMRESATTRS_SERVICE_INSTANCE_ID] =
        gcpResources.attributes[Semconv.SEMRESATTRS_FAAS_ID].toString();
    } else {
      logger.warn(
        'WARNING: running under Cloud Functions, but FAAS_ID ' +
          'resource attribute is not set. ' +
          'This may lead to Send TimeSeries errors',
      );
    }
  } else {
    logger.warn(
      'WARNING: Using Default Cloud Functions Behavior',  );
  }

  const resources = gcpResources.merge(new Resource(RESOURCE_ATTRIBUTES));
  await resources.waitForAsyncAttributes();
  logger.info('Got Resource Attributes: '+JSON.stringify(resources));

  const exporter = new GcpMetricExporter({prefix: 'custom.googleapis.com'});

  const meterProvider = new MeterProvider({
    resource: resources,
    readers: [
      new PeriodicExportingMetricReader({
        exportIntervalMillis: 10_000,
        exportTimeoutMillis: 10_000,
        exporter: exporter,
      }),
    ],
  });

  const COUNTERS_PREFIX = "nielm-test/"

  const meter = meterProvider.getMeter(COUNTERS_PREFIX);

  requestCounter = meter.createCounter(COUNTERS_PREFIX + "request-counter");

  backgroundCounter = meter.createCounter(COUNTERS_PREFIX + "background-counter");

  logger.info('Metrics initialized, counters ready');
}

initMetrics().then(() => {
  function backgroundTask() {
    backgroundCounter.add(1);
  }
  setInterval(backgroundTask, 2_000);

  logger.info('Background task started - increments counter ever 2 seconds');

}).catch((e) => {
  logger.error(e);
  process.exit(1);
});


functions.http('handleHttpReq', (req, res) => {
  logger.info('handling HTTP request');
  requestCounter.add(1);
  res.send('OK');
});

logger.info('HTTP handler ready.');
