<?php
/**
 * Text-generation model that targets the WebLLM loopback endpoint.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use WordPress\AiClient\Providers\Http\DTO\Request;
use WordPress\AiClient\Providers\Http\Enums\HttpMethodEnum;
use WordPress\AiClient\Providers\OpenAiCompatibleImplementation\AbstractOpenAiCompatibleTextGenerationModel;

class WebLlmModel extends AbstractOpenAiCompatibleTextGenerationModel {

	/**
	 * {@inheritDoc}
	 */
	protected function createRequest(
		HttpMethodEnum $method,
		string $path,
		array $headers = [],
		$data = null
	): Request {
		// Auth is handled via the `Authorization: Bearer <secret>` header
		// that the SDK auto-injects from the registered
		// ApiKeyRequestAuthentication; no nonce juggling needed here.
		return new Request(
			$method,
			WebLlmProvider::url( $path ),
			$headers,
			$data,
			$this->getRequestOptions()
		);
	}
}
