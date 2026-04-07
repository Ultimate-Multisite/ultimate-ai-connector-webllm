<?php
/**
 * WebLLM provider class.
 *
 * The "endpoint" is the same WordPress site's REST loopback (`/wp-json/webllm/v1`).
 * That route enqueues a job and blocks until the browser worker tab posts back
 * with an OpenAI-shaped response.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use WordPress\AiClient\Common\Exception\RuntimeException;
use WordPress\AiClient\Providers\ApiBasedImplementation\AbstractApiProvider;
use WordPress\AiClient\Providers\ApiBasedImplementation\ListModelsApiBasedProviderAvailability;
use WordPress\AiClient\Providers\Contracts\ModelMetadataDirectoryInterface;
use WordPress\AiClient\Providers\Contracts\ProviderAvailabilityInterface;
use WordPress\AiClient\Providers\DTO\ProviderMetadata;
use WordPress\AiClient\Providers\Enums\ProviderTypeEnum;
use WordPress\AiClient\Providers\Http\Enums\RequestAuthenticationMethod;
use WordPress\AiClient\Providers\Models\Contracts\ModelInterface;
use WordPress\AiClient\Providers\Models\DTO\ModelMetadata;

class WebLlmProvider extends AbstractApiProvider {

	/**
	 * Loopback base URL. Set during register_provider().
	 *
	 * @var string
	 */
	public static string $endpointUrl = '';

	/**
	 * {@inheritDoc}
	 */
	protected static function baseUrl(): string {
		return rtrim( self::$endpointUrl, '/' );
	}

	/**
	 * {@inheritDoc}
	 */
	protected static function createModel(
		ModelMetadata $modelMetadata,
		ProviderMetadata $providerMetadata
	): ModelInterface {
		foreach ( $modelMetadata->getSupportedCapabilities() as $capability ) {
			if ( $capability->isTextGeneration() ) {
				return new WebLlmModel( $modelMetadata, $providerMetadata );
			}
		}

		throw new RuntimeException(
			'Unsupported model capabilities for WebLLM provider.'
		);
	}

	/**
	 * {@inheritDoc}
	 */
	protected static function createProviderMetadata(): ProviderMetadata {
		return new ProviderMetadata(
			'ultimate-ai-connector-webllm',
			'WebLLM (Browser GPU)',
			ProviderTypeEnum::server(),
			null,
			RequestAuthenticationMethod::apiKey(),
			__( 'Run LLM inference entirely in the user\'s browser via WebGPU + WebLLM. A persistent worker tab provides the GPU; the WordPress site brokers requests so any logged-in device can use it.', 'ultimate-ai-connector-webllm' )
		);
	}

	/**
	 * {@inheritDoc}
	 */
	protected static function createProviderAvailability(): ProviderAvailabilityInterface {
		return new ListModelsApiBasedProviderAvailability(
			static::modelMetadataDirectory()
		);
	}

	/**
	 * {@inheritDoc}
	 */
	protected static function createModelMetadataDirectory(): ModelMetadataDirectoryInterface {
		return new WebLlmModelDirectory();
	}
}
