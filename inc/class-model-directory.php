<?php
/**
 * Model metadata directory for the WebLLM provider.
 *
 * The list comes from the worker tab — when the worker registers, it sends the
 * full `prebuiltAppConfig.model_list` from the installed `@mlc-ai/web-llm`
 * package, which is then served back through `/webllm/v1/models`.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use WordPress\AiClient\Providers\Http\DTO\Request;
use WordPress\AiClient\Providers\Http\DTO\Response;
use WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum;
use WordPress\AiClient\Providers\Models\DTO\ModelMetadata;
use WordPress\AiClient\Providers\Models\DTO\SupportedOption;
use WordPress\AiClient\Providers\Models\Enums\CapabilityEnum;
use WordPress\AiClient\Providers\Models\Enums\OptionEnum;
use WordPress\AiClient\Providers\OpenAiCompatibleImplementation\AbstractOpenAiCompatibleModelMetadataDirectory;

class WebLlmModelDirectory extends AbstractOpenAiCompatibleModelMetadataDirectory {

	/**
	 * {@inheritDoc}
	 */
	protected function createRequest(
		HttpMethodEnum $method,
		string $path,
		array $headers = [],
		$data = null
	): Request {
		return new Request(
			$method,
			WebLlmProvider::url( $path ),
			$headers,
			$data
		);
	}

	/**
	 * {@inheritDoc}
	 */
	protected function parseResponseToModelMetadataList( Response $response ): array {
		$responseData = $response->getData();

		$modelsData = [];
		if ( isset( $responseData['data'] ) && is_array( $responseData['data'] ) ) {
			$modelsData = $responseData['data'];
		}

		if ( empty( $modelsData ) ) {
			return [];
		}

		$capabilities = [
			CapabilityEnum::textGeneration(),
			CapabilityEnum::chatHistory(),
		];

		$options = [
			new SupportedOption( OptionEnum::systemInstruction() ),
			new SupportedOption( OptionEnum::maxTokens() ),
			new SupportedOption( OptionEnum::temperature() ),
			new SupportedOption( OptionEnum::topP() ),
			new SupportedOption( OptionEnum::stopSequences() ),
			new SupportedOption( OptionEnum::frequencyPenalty() ),
			new SupportedOption( OptionEnum::presencePenalty() ),
			new SupportedOption( OptionEnum::functionDeclarations() ),
			new SupportedOption( OptionEnum::customOptions() ),
			new SupportedOption( OptionEnum::inputModalities() ),
			new SupportedOption( OptionEnum::outputModalities() ),
			new SupportedOption( OptionEnum::outputMimeType(), [ 'text/plain', 'application/json' ] ),
			new SupportedOption( OptionEnum::outputSchema() ),
		];

		return array_values(
			array_map(
				static function ( array $modelData ) use ( $capabilities, $options ): ModelMetadata {
					$id   = $modelData['id'] ?? $modelData['name'] ?? 'unknown';
					$name = $modelData['name'] ?? $modelData['id'] ?? $id;
					return new ModelMetadata( $id, $name, $capabilities, $options );
				},
				$modelsData
			)
		);
	}
}
