use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionModelState {
    pub(crate) current_model_id: String,
    pub(crate) available_models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelInfo {
    pub(crate) model_id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(rename(serialize = "metadata", deserialize = "_meta"), default)]
    pub(crate) metadata: Option<ModelMetadata>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelMetadata {
    #[serde(default)]
    pub(crate) total_context_tokens: Option<u64>,
    #[serde(default)]
    pub(crate) agent_type: Option<String>,
    #[serde(default)]
    pub(crate) supports_reasoning_effort: Option<bool>,
    #[serde(default)]
    pub(crate) reasoning_effort: Option<String>,
    #[serde(default)]
    pub(crate) reasoning_efforts: Vec<ReasoningEffortInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReasoningEffortInfo {
    pub(crate) id: String,
    pub(crate) value: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(rename = "default", default)]
    pub(crate) is_default: bool,
}

pub(crate) fn parse_session_models(result: &Value) -> Result<Option<SessionModelState>, String> {
    result.get("models").map(parse_model_state).transpose()
}

pub(crate) fn parse_initialize_models(result: &Value) -> Result<Option<SessionModelState>, String> {
    result
        .pointer("/_meta/modelState")
        .map(parse_model_state)
        .transpose()
}

pub(crate) fn reasoning_effort_value(
    models: &SessionModelState,
    requested_effort: &str,
) -> Result<String, String> {
    let metadata = models
        .available_models
        .iter()
        .find(|model| model.model_id == models.current_model_id)
        .and_then(|model| model.metadata.as_ref())
        .ok_or_else(|| {
            "Grok Build did not advertise reasoning controls for the current model.".to_string()
        })?;

    if metadata.supports_reasoning_effort == Some(false) || metadata.reasoning_efforts.is_empty() {
        return Err(
            "Grok Build did not advertise reasoning controls for the current model.".to_string(),
        );
    }

    metadata
        .reasoning_efforts
        .iter()
        .find(|effort| effort.id == requested_effort || effort.value == requested_effort)
        .map(|effort| effort.value.clone())
        .ok_or_else(|| "Choose a reasoning effort advertised by Grok Build.".to_string())
}

pub(crate) fn resolve_initial_model_selection(
    models: Option<&SessionModelState>,
    requested_model_id: Option<&str>,
    requested_reasoning_effort: Option<&str>,
) -> Result<Option<(String, Option<String>)>, String> {
    if requested_model_id.is_none() && requested_reasoning_effort.is_none() {
        return Ok(None);
    }

    let models = models.ok_or_else(|| {
        "Grok Build did not advertise model selection for this session.".to_string()
    })?;
    let selected_model_id = requested_model_id
        .unwrap_or(&models.current_model_id)
        .to_string();
    if !models
        .available_models
        .iter()
        .any(|model| model.model_id == selected_model_id)
    {
        return Err("The selected model is no longer available in Grok Build.".to_string());
    }

    let selected_reasoning_effort = if let Some(requested_effort) = requested_reasoning_effort {
        let mut selected_models = models.clone();
        selected_models.current_model_id = selected_model_id.clone();
        Some(reasoning_effort_value(&selected_models, requested_effort)?)
    } else {
        None
    };

    Ok(Some((selected_model_id, selected_reasoning_effort)))
}

pub(crate) fn model_reasoning_effort<'a>(
    models: &'a SessionModelState,
    model_id: &str,
) -> Option<&'a str> {
    models
        .available_models
        .iter()
        .find(|model| model.model_id == model_id)
        .and_then(|model| model.metadata.as_ref())
        .and_then(|metadata| metadata.reasoning_effort.as_deref())
}

pub(crate) fn record_model_selection(
    models: &mut SessionModelState,
    model_id: String,
    reasoning_effort: Option<String>,
) {
    models.current_model_id = model_id;
    let Some(reasoning_effort) = reasoning_effort else {
        return;
    };
    if let Some(metadata) = models
        .available_models
        .iter_mut()
        .find(|model| model.model_id == models.current_model_id)
        .and_then(|model| model.metadata.as_mut())
    {
        metadata.reasoning_effort = Some(reasoning_effort);
    }
}

fn parse_model_state(value: &Value) -> Result<SessionModelState, String> {
    let models = serde_json::from_value::<SessionModelState>(value.clone())
        .map_err(|_| "Grok Build returned invalid model information.".to_string())?;
    let current_model_is_available = models
        .available_models
        .iter()
        .any(|model| model.model_id == models.current_model_id);
    if models.available_models.is_empty() || !current_model_is_available {
        return Err("Grok Build returned invalid model information.".to_string());
    }

    Ok(models)
}
