const cds = require('@sap/cds')
const LOG = cds.log('telemetry')

const { trace } = require('@opentelemetry/api')
const { Resource } = require('@opentelemetry/resources')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { BatchSpanProcessor, SimpleSpanProcessor, SamplingDecision } = require('@opentelemetry/sdk-trace-base')
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')

const { getDynatraceMetadata, getDynatraceCredentials, getCloudLoggingCredentials, _require } = require('../utils')

function _getSampler() {
  const { ignoreIncomingPaths } = cds.env.requires.telemetry.instrumentations?.http?.config || {}

  let _shouldSample
  if (!Array.isArray(ignoreIncomingPaths) || !ignoreIncomingPaths.length) _shouldSample = () => true
  else {
    // eslint-disable-next-line no-unused-vars
    _shouldSample = (context, traceId, name, spanKind, attributes, links) => {
      const originalUrl = attributes?.['http.originalUrl']
      if (!originalUrl) return true
      return !ignoreIncomingPaths.some(p => originalUrl.startsWith(p))
    }
  }

  function _filterSampler(_shouldSample, parent) {
    return {
      shouldSample(context, traceId, name, spanKind, attributes, links) {
        if (!_shouldSample(context, traceId, name, spanKind, attributes, links))
          return { decision: SamplingDecision.NOT_RECORD }
        return parent.shouldSample(context, traceId, name, spanKind, attributes, links)
      }
    }
  }

  let sampler
  const { kind, root, ratio } = cds.env.requires.telemetry.tracing.sampler
  const base = require('@opentelemetry/sdk-trace-base')
  if (!base[kind]) throw new Error(`Unknown sampler ${kind}`)
  if (kind === 'ParentBasedSampler') {
    if (!base[root]) throw new Error(`Unknown sampler ${root}`)
    sampler = new base[kind]({ root: new base[root](ratio || 0) })
  } else {
    sampler = new base[kind]()
  }

  return _filterSampler(_shouldSample, sampler)
}

function _getPropagator() {
  const propagators = []
  const core = require('@opentelemetry/core')
  for (const each of cds.env.requires.telemetry.tracing.propagators) {
    if (typeof each === 'string') {
      if (!core[each]) throw new Error(`Unknown propagator "${each}" in module "@opentelemetry/core"`)
      propagators.push(new core[each]())
    } else {
      const module = _require(each.module)
      if (!module[each.class]) throw new Error(`Unknown propagator "${each.class}" in module "${each.module}"`)
      propagators.push(new module[each.class]({ ...(each.config || {}) }))
    }
  }
  return new core.CompositePropagator({ propagators })
}

function _getInstrumentations() {
  const instrumentations = []
  for (const each of Object.values(cds.env.requires.telemetry.instrumentations)) {
    const module = _require(each.module)
    if (!module[each.class]) throw new Error(`Unknown instrumentation "${each.class}" in module "${each.module}"`)
    instrumentations.push(new module[each.class]({ ...(each.config || {}) }))
  }
  return instrumentations
}

function _getExporter() {
  const tracingExporter = cds.env.requires.telemetry.tracing.exporter
  // use _require for better error message
  const tracingExporterModule =
    tracingExporter.module === '@cap-js/telemetry' ? require('../exporter') : _require(tracingExporter.module)
  if (!tracingExporterModule[tracingExporter.class])
    throw new Error(`Unknown tracing exporter "${tracingExporter.class}" in module "${tracingExporter.module}"`)
  const tracingConfig = { ...(tracingExporter.config || {}) }

  const dynatrace = getDynatraceCredentials()
  if (dynatrace && cds.env.requires.telemetry.kind.match(/dynatrace/)) {
    tracingConfig.url ??= `${dynatrace.apiurl}/v2/otlp/v1/traces`
    tracingConfig.headers ??= {}
    // dynatrace.rest_apitoken?.token is deprecated and only supported for compatibility reasons
    const { token_name } = cds.env.requires.telemetry
    const token = dynatrace[token_name] || dynatrace.rest_apitoken?.token
    if (!token)
      throw new Error(`Neither "${token_name}" nor deprecated "rest_apitoken.token" found in Dynatrace credentials`)
    tracingConfig.headers.authorization ??= `Api-Token ${token}`
  }

  const clc = getCloudLoggingCredentials()
  if (clc && cds.env.requires.telemetry.kind.match(/cloud-logging/)) {
    tracingConfig.url ??= clc.url
    tracingConfig.credentials ??= clc.credentials
  }

  const exporter = new tracingExporterModule[tracingExporter.class](tracingConfig)
  LOG._debug && LOG.debug('Using tracing exporter:', exporter)
  return exporter
}

module.exports = resource => {
  if (!cds.env.requires.telemetry.tracing?.exporter) return

  /*
   * general setup
   */
  let tracerProvider = trace.getTracerProvider()
  if (!tracerProvider.getDelegateTracer()) {
    const dtmetadata = getDynatraceMetadata()
    resource = new Resource({}).merge(resource).merge(dtmetadata)
    tracerProvider = new NodeTracerProvider({ resource, sampler: _getSampler() })
    tracerProvider.register({ propagator: _getPropagator() })
    const instrumentations = _getInstrumentations()
    registerInstrumentations({ tracerProvider, instrumentations })
  } else {
    LOG._warn && LOG.warn('TracerProvider already initialized by a different module. It will be used as is.')
    tracerProvider = tracerProvider.getDelegate()
  }
  if (process.env.DT_NODE_PRELOAD_OPTIONS && cds.env.requires.telemetry.kind.match(/dynatrace/)) {
    // if Dynatrace OneAgent is present, no exporter is needed
    LOG._info && LOG.info('Dynatrace OneAgent detected, disabling tracing exporter')
  } else {
    const exporter = _getExporter()
    const spanProcessor =
      process.env.NODE_ENV === 'production' ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter)
    tracerProvider.addSpanProcessor(spanProcessor)
  }

  // REVISIT: better way to set/ pass tracer?
  cds._telemetry.tracer = trace.getTracer('@cap-js/telemetry', require('../../package.json').version)

  // REVISIT: only start tracing once served
  cds.on('served', () => {
    cds._telemetry.tracer._active = true
  })

  /*
   * add CAP instrumentations
   */
  require('./cds')()
  // REVISIT: we should be able to remove okra instrumentation entirely, but keep behind feature flag for now
  if (process.env.TRACE_OKRA) require('./okra')()
  require('./cloud_sdk')()
}
