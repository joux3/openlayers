goog.provide('ol.renderer.canvas.VectorTileLayer');

goog.require('ol');
goog.require('ol.dom');
goog.require('ol.extent');
goog.require('ol.proj');
goog.require('ol.proj.Units');
goog.require('ol.layer.VectorTileRenderType');
goog.require('ol.render.ReplayType');
goog.require('ol.render.canvas');
goog.require('ol.render.canvas.ReplayGroup');
goog.require('ol.render.replay');
goog.require('ol.renderer.canvas.TileLayer');
goog.require('ol.renderer.vector');
goog.require('ol.size');
goog.require('ol.transform');


/**
 * @constructor
 * @extends {ol.renderer.canvas.TileLayer}
 * @param {ol.layer.VectorTile} layer VectorTile layer.
 */
ol.renderer.canvas.VectorTileLayer = function(layer) {

  this.context = null;

  ol.renderer.canvas.TileLayer.call(this, layer);

  /**
   * @private
   * @type {number}
   */
  this.renderedLayerRevision_;

  this.tilesThatWouldBeUsed_ = [];
  this.tileWorkQueue = {};
  this.idleCallbackRequested = false;

  /**
   * @private
   * @type {ol.Transform}
   */
  this.tmpTransform_ = ol.transform.create();

  // Use lower resolution for pure vector rendering. Closest resolution otherwise.
  this.zDirection =
      layer.getRenderMode() == ol.layer.VectorTileRenderType.VECTOR ? 1 : 0;

};
ol.inherits(ol.renderer.canvas.VectorTileLayer, ol.renderer.canvas.TileLayer);


/**
 * @const
 * @type {!Object.<string, Array.<ol.render.ReplayType>>}
 */
ol.renderer.canvas.VectorTileLayer.IMAGE_REPLAYS = {
  'image': ol.render.replay.ORDER,
  'hybrid': [ol.render.ReplayType.POLYGON, ol.render.ReplayType.LINE_STRING]
};


/**
 * @const
 * @type {!Object.<string, Array.<ol.render.ReplayType>>}
 */
ol.renderer.canvas.VectorTileLayer.VECTOR_REPLAYS = {
  'hybrid': [ol.render.ReplayType.IMAGE, ol.render.ReplayType.TEXT],
  'vector': ol.render.replay.ORDER
};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorTileLayer.prototype.prepareFrame = function(frameState, layerState) {
  this.tilesThatWouldBeUsed_ = []
  var layer = this.getLayer();
  var layerRevision = layer.getRevision();
  if (this.renderedLayerRevision_ != layerRevision) {
    this.renderedTiles.length = 0;
    var renderMode = layer.getRenderMode();
    if (!this.context && renderMode != ol.layer.VectorTileRenderType.VECTOR) {
      this.context = ol.dom.createCanvasContext2D();
    }
    if (this.context && renderMode == ol.layer.VectorTileRenderType.VECTOR) {
      this.context = null;
    }
  }
  var res = ol.renderer.canvas.TileLayer.prototype.prepareFrame.apply(this, arguments);
  this.renderedLayerRevision_ = layerRevision;
  this.renderedTiles.forEach(function (tile) {
    if (tile.getReplayState().renderedRevision < this.renderedLayerRevision_) {
      this.renderedLayerRevision_ = tile.getReplayState().renderedRevision;
    }
  }.bind(this))
  return res;
};

/**
 *
 * @override
 */
ol.renderer.canvas.VectorTileLayer.prototype.loadedTileFilter = function(tile) {
  return tile.getReplayState().renderedRevision !== -1
}

ol.renderer.canvas.VectorTileLayer.prototype.tileWorkScheduler = function(tile, functionToRun) {
  this.tileWorkQueue[tile.tileCoord.join(',')] = functionToRun
  if (this.idleCallbackRequested) {
    return;
  }

  var doWork = function(idleTime) {
    this.idleCallbackRequested = false;
    var tileKeys = Object.keys(this.tileWorkQueue).sort();
    for (var i = 0; i < tileKeys.length; i++) {
      var tileKey = tileKeys[i];
      var isComplete = this.tileWorkQueue[tileKey](idleTime);
      if (isComplete) {
        delete this.tileWorkQueue[tileKey];
      } else {
        this.idleCallbackRequested = true;
        window.requestIdleCallback(doWork);
        return;
      }
    }
  }.bind(this)

  this.idleCallbackRequested = true;
  window.requestIdleCallback(doWork);
}


/**
 * @param {ol.VectorTile} tile Tile.
 * @param {olx.FrameState} frameState Frame state.
 * @private
 */
ol.renderer.canvas.VectorTileLayer.prototype.createReplayGroup_ = function(tile,
    frameState) {
  var layer = this.getLayer();
  var pixelRatio = frameState.pixelRatio;
  var projection = frameState.viewState.projection;
  var revision = layer.getRevision();
  var renderOrder = layer.getRenderOrder() || null;

  var replayState = tile.getReplayState();
  if (!replayState.dirty && replayState.renderedRevision == revision &&
    replayState.renderedRenderOrder == renderOrder ||
    replayState.inProgressRevision == revision &&
    replayState.inProgressRenderOrder == renderOrder) {
    return;
  }

  replayState.inProgressRevision = revision;
  replayState.inProgressRenderOrder = renderOrder;

  var newDirty = false;

  var source = /** @type {ol.source.VectorTile} */ (layer.getSource());
  var tileGrid = source.getTileGrid();
  var tileCoord = tile.tileCoord;
  var tileProjection = tile.getProjection();
  var resolution = tileGrid.getResolution(tileCoord[0]);
  var extent, reproject, tileResolution;
  if (tileProjection.getUnits() == ol.proj.Units.TILE_PIXELS) {
    var tilePixelRatio = tileResolution = source.getTilePixelRatio();
    var tileSize = ol.size.toSize(tileGrid.getTileSize(tileCoord[0]));
    extent = [0, 0, tileSize[0] * tilePixelRatio, tileSize[1] * tilePixelRatio];
  } else {
    tileResolution = resolution;
    extent = tileGrid.getTileCoordExtent(tileCoord);
    if (!ol.proj.equivalent(projection, tileProjection)) {
      reproject = true;
      tile.setProjection(projection);
    }
  }

  var replayGroup = new ol.render.canvas.ReplayGroup(0, extent,
    tileResolution, source.getOverlaps(), layer.getRenderBuffer());
  var squaredTolerance = ol.renderer.vector.getSquaredTolerance(
    tileResolution, pixelRatio);

  /**
   * @param {ol.Feature|ol.render.Feature} feature Feature.
   * @this {ol.renderer.canvas.VectorTileLayer}
   */
  function renderFeature(feature) {
    var styles;
    var styleFunction = feature.getStyleFunction();
    if (styleFunction) {
      styles = styleFunction.call(/** @type {ol.Feature} */ (feature), resolution);
    } else {
      styleFunction = layer.getStyleFunction();
      if (styleFunction) {
        styles = styleFunction(feature, resolution);
      }
    }
    if (styles) {
      if (!Array.isArray(styles)) {
        styles = [styles];
      }
      var dirty = this.renderFeature(feature, squaredTolerance, styles,
        replayGroup);
      newDirty = newDirty || dirty;
    }
  }

  var features = tile.getFeatures();
  if (renderOrder && renderOrder !== replayState.renderedRenderOrder) {
    features.sort(renderOrder);
  }

  var boundRenderFeatures = renderFeatures.bind(this);
  this.tileWorkScheduler(tile, boundRenderFeatures);

  var i = 0;
  function renderFeatures(idleTime) {
    if (replayState.inProgressRevision !== revision || replayState.inProgressRenderOrder !== renderOrder) {
      return true;
    }
    if (this.tilesThatWouldBeUsed_.indexOf(tile) === -1) {
      replayState.inProgressRevision = -1;
      replayState.inProgressRenderOrder = undefined;
      return true;
    }
    var feature;
    for (var ii = features.length; i < ii; ++i) {
      feature = features[i];
      if (reproject) {
        feature.getGeometry().transform(tileProjection, projection);
      }
      renderFeature.call(this, feature);
      if (idleTime.timeRemaining() === 0) {
        ++i;
        return false;
      }
    }

    replayGroup.finish();

    replayState.dirty = newDirty;
    replayState.renderedRevision = revision;
    replayState.renderedRenderOrder = renderOrder;
    replayState.replayGroup = replayGroup;
    replayState.resolution = NaN;

    this.renderIfReadyAndVisible();
    return true;
  }
};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorTileLayer.prototype.drawTileImage = function(
    tile, frameState, layerState, x, y, w, h, gutter) {
  var vectorTile = /** @type {ol.VectorTile} */ (tile);
  if (this.context) {
    this.renderTileImage_(vectorTile, frameState, layerState);
    ol.renderer.canvas.TileLayer.prototype.drawTileImage.apply(this, arguments);
  }
};


/**
 *
 * @override
 */
ol.renderer.canvas.VectorTileLayer.prototype.tileWouldBeUsed = function(tile, frameState) {
  this.tilesThatWouldBeUsed_.push(tile);
  this.createReplayGroup_(/** @type {ol.VectorTile} */ (tile), frameState);
};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorTileLayer.prototype.forEachFeatureAtCoordinate = function(coordinate, frameState, hitTolerance, callback, thisArg) {
  var resolution = frameState.viewState.resolution;
  var rotation = frameState.viewState.rotation;
  hitTolerance = hitTolerance == undefined ? 0 : hitTolerance;
  var layer = this.getLayer();
  /** @type {Object.<string, boolean>} */
  var features = {};

  /** @type {Array.<ol.VectorTile>} */
  var replayables = this.renderedTiles;

  var source = /** @type {ol.source.VectorTile} */ (layer.getSource());
  var tileGrid = source.getTileGrid();
  var found, tileSpaceCoordinate;
  var i, ii, origin, replayGroup;
  var tile, tileCoord, tileExtent, tilePixelRatio, tileResolution;
  for (i = 0, ii = replayables.length; i < ii; ++i) {
    tile = replayables[i];
    tileCoord = tile.tileCoord;
    tileExtent = source.getTileGrid().getTileCoordExtent(tileCoord, this.tmpExtent);
    if (!ol.extent.containsCoordinate(ol.extent.buffer(tileExtent, hitTolerance * resolution), coordinate)) {
      continue;
    }
    if (tile.getProjection().getUnits() === ol.proj.Units.TILE_PIXELS) {
      origin = ol.extent.getTopLeft(tileExtent);
      tilePixelRatio = source.getTilePixelRatio();
      tileResolution = tileGrid.getResolution(tileCoord[0]) / tilePixelRatio;
      tileSpaceCoordinate = [
        (coordinate[0] - origin[0]) / tileResolution,
        (origin[1] - coordinate[1]) / tileResolution
      ];
      resolution = tilePixelRatio;
    } else {
      tileSpaceCoordinate = coordinate;
    }
    replayGroup = tile.getReplayState().replayGroup;
    found = found || replayGroup.forEachFeatureAtCoordinate(
        tileSpaceCoordinate, resolution, rotation, hitTolerance, {},
        /**
         * @param {ol.Feature|ol.render.Feature} feature Feature.
         * @return {?} Callback result.
         */
        function(feature) {
          var key = ol.getUid(feature).toString();
          if (!(key in features)) {
            features[key] = true;
            return callback.call(thisArg, feature, layer);
          }
        });
  }
  return found;
};


/**
 * @param {ol.Tile} tile Tile.
 * @param {olx.FrameState} frameState Frame state.
 * @return {ol.Transform} transform Transform.
 * @private
 */
ol.renderer.canvas.VectorTileLayer.prototype.getReplayTransform_ = function(tile, frameState) {
  if (tile.getProjection().getUnits() == ol.proj.Units.TILE_PIXELS) {
    var layer = this.getLayer();
    var source = /** @type {ol.source.VectorTile} */ (layer.getSource());
    var tileGrid = source.getTileGrid();
    var tileCoord = tile.tileCoord;
    var tileResolution =
        tileGrid.getResolution(tileCoord[0]) / source.getTilePixelRatio();
    var viewState = frameState.viewState;
    var pixelRatio = frameState.pixelRatio;
    var renderResolution = viewState.resolution / pixelRatio;
    var tileExtent = tileGrid.getTileCoordExtent(tileCoord, this.tmpExtent);
    var center = viewState.center;
    var origin = ol.extent.getTopLeft(tileExtent);
    var size = frameState.size;
    var offsetX = Math.round(pixelRatio * size[0] / 2);
    var offsetY = Math.round(pixelRatio * size[1] / 2);
    return ol.transform.compose(this.tmpTransform_,
        offsetX, offsetY,
        tileResolution / renderResolution, tileResolution / renderResolution,
        viewState.rotation,
        (origin[0] - center[0]) / tileResolution,
        (center[1] - origin[1]) / tileResolution);
  } else {
    return this.getTransform(frameState, 0);
  }
};


/**
 * Handle changes in image style state.
 * @param {ol.events.Event} event Image style change event.
 * @private
 */
ol.renderer.canvas.VectorTileLayer.prototype.handleStyleImageChange_ = function(event) {
  this.renderIfReadyAndVisible();
};


/**
 * @inheritDoc
 */
ol.renderer.canvas.VectorTileLayer.prototype.postCompose = function(context, frameState, layerState) {
  var renderMode = this.getLayer().getRenderMode();
  var replays = ol.renderer.canvas.VectorTileLayer.VECTOR_REPLAYS[renderMode];
  if (replays) {
    var pixelRatio = frameState.pixelRatio;
    var rotation = frameState.viewState.rotation;
    var size = frameState.size;
    var offsetX = Math.round(pixelRatio * size[0] / 2);
    var offsetY = Math.round(pixelRatio * size[1] / 2);
    var tiles = this.renderedTiles;
    var clips = [];
    var zs = [];
    for (var i = tiles.length - 1; i >= 0; --i) {
      var tile = /** @type {ol.VectorTile} */ (tiles[i]);
      // Create a clip mask for regions in this low resolution tile that are
      // already filled by a higher resolution tile
      var transform = this.getReplayTransform_(tile, frameState);
      var currentClip = tile.getReplayState().replayGroup.getClipCoords(transform);
      var currentZ = tile.tileCoord[0];
      context.save();
      context.globalAlpha = layerState.opacity;
      ol.render.canvas.rotateAtOffset(context, -rotation, offsetX, offsetY);
      for (var j = 0, jj = clips.length; j < jj; ++j) {
        var clip = clips[j];
        if (currentZ < zs[j]) {
          context.beginPath();
          // counter-clockwise (outer ring) for current tile
          context.moveTo(currentClip[0], currentClip[1]);
          context.lineTo(currentClip[2], currentClip[3]);
          context.lineTo(currentClip[4], currentClip[5]);
          context.lineTo(currentClip[6], currentClip[7]);
          // clockwise (inner ring) for higher resolution tile
          context.moveTo(clip[6], clip[7]);
          context.lineTo(clip[4], clip[5]);
          context.lineTo(clip[2], clip[3]);
          context.lineTo(clip[0], clip[1]);
          context.clip();
        }
      }
      var replayGroup = tile.getReplayState().replayGroup;
      replayGroup.replay(context, pixelRatio, transform, rotation, {}, replays);
      context.restore();
      clips.push(currentClip);
      zs.push(currentZ);
    }
  }
  ol.renderer.canvas.TileLayer.prototype.postCompose.apply(this, arguments);
};


/**
 * @param {ol.Feature|ol.render.Feature} feature Feature.
 * @param {number} squaredTolerance Squared tolerance.
 * @param {(ol.style.Style|Array.<ol.style.Style>)} styles The style or array of
 *     styles.
 * @param {ol.render.canvas.ReplayGroup} replayGroup Replay group.
 * @return {boolean} `true` if an image is loading.
 */
ol.renderer.canvas.VectorTileLayer.prototype.renderFeature = function(feature, squaredTolerance, styles, replayGroup) {
  if (!styles) {
    return false;
  }
  var loading = false;
  if (Array.isArray(styles)) {
    for (var i = 0, ii = styles.length; i < ii; ++i) {
      loading = ol.renderer.vector.renderFeature(
          replayGroup, feature, styles[i], squaredTolerance,
          this.handleStyleImageChange_, this) || loading;
    }
  } else {
    loading = ol.renderer.vector.renderFeature(
        replayGroup, feature, styles, squaredTolerance,
        this.handleStyleImageChange_, this) || loading;
  }
  return loading;
};


/**
 * @param {ol.VectorTile} tile Tile.
 * @param {olx.FrameState} frameState Frame state.
 * @param {ol.LayerState} layerState Layer state.
 * @private
 */
ol.renderer.canvas.VectorTileLayer.prototype.renderTileImage_ = function(
    tile, frameState, layerState) {
  var layer = this.getLayer();
  var replayState = tile.getReplayState();
  var revision = layer.getRevision();
  var replays = ol.renderer.canvas.VectorTileLayer.IMAGE_REPLAYS[layer.getRenderMode()];
  if (replays && replayState.renderedTileRevision !== revision) {
    replayState.renderedTileRevision = revision;
    var tileCoord = tile.tileCoord;
    var z = tile.tileCoord[0];
    var pixelRatio = frameState.pixelRatio;
    var source = layer.getSource();
    var tileGrid = source.getTileGrid();
    var tilePixelRatio = source.getTilePixelRatio();
    var transform = ol.transform.reset(this.tmpTransform_);
    if (tile.getProjection().getUnits() == ol.proj.Units.TILE_PIXELS) {
      var renderPixelRatio = pixelRatio / tilePixelRatio;
      ol.transform.scale(transform, renderPixelRatio, renderPixelRatio);
    } else {
      var resolution = tileGrid.getResolution(z);
      var pixelScale = pixelRatio / resolution;
      var tileExtent = tileGrid.getTileCoordExtent(tileCoord, this.tmpExtent);
      ol.transform.scale(transform, pixelScale, -pixelScale);
      ol.transform.translate(transform, -tileExtent[0], -tileExtent[3]);
    }

    var context = tile.getContext();
    var size = source.getTilePixelSize(z, pixelRatio, frameState.viewState.projection);
    context.canvas.width = size[0];
    context.canvas.height = size[1];
    replayState.replayGroup.replay(context, pixelRatio, transform, 0, {}, replays);
  }
};
