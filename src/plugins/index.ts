/**
 * plugins/index.ts — Plugin loader
 *
 * This is the ONLY file you edit when adding a new plugin.
 * Import the plugin class and call registry.register(). That's it.
 * The registry handles detection, activation, deactivation, and all UI wiring.
 */

import type { PluginRegistry } from '../core/plugin';
import { DatabricksPlugin }   from './databricks';
import { DbtPlugin }          from './dbt';
import { AirflowPlugin }      from './airflow';
import { PytestPlugin }       from './pytest';
import { FastAPIPlugin }      from './fastapi';
import { DjangoPlugin }       from './django';
import { TerraformPlugin }    from './terraform';
import { KubernetesPlugin }  from './kubernetes';
import { DockerPlugin }      from './docker';
import { JupyterPlugin }    from './jupyter';
import { PyTorchPlugin }   from './pytorch';
import { SecurityPlugin }  from './security';
import { GitPlugin }       from './git';
import { AwsPlugin }       from './aws';
import { GCPPlugin }       from './gcp';
import { AzurePlugin }     from './azure';
import { DatabricksConnectedPlugin } from './databricksConnected';
import { AwsConnectedPlugin }        from './awsConnected';
import { GCPConnectedPlugin }        from './gcpConnected';
import { AzureConnectedPlugin }      from './azureConnected';

// ── Register all plugins ──────────────────────────────────────────────────────

export function registerPlugins(registry: PluginRegistry): void {
  registry.register(new DatabricksPlugin());
  registry.register(new DbtPlugin());
  registry.register(new AirflowPlugin());
  registry.register(new PytestPlugin());
  registry.register(new FastAPIPlugin());
  registry.register(new DjangoPlugin());
  registry.register(new TerraformPlugin());
  registry.register(new KubernetesPlugin());
  registry.register(new DockerPlugin());
  registry.register(new JupyterPlugin());
  registry.register(new PyTorchPlugin());
  registry.register(new SecurityPlugin());
  registry.register(new GitPlugin());
  registry.register(new AwsPlugin());
  registry.register(new GCPPlugin());
  registry.register(new AzurePlugin());
  registry.register(new DatabricksConnectedPlugin());
  registry.register(new AwsConnectedPlugin());
  registry.register(new GCPConnectedPlugin());
  registry.register(new AzureConnectedPlugin());

  // Add more plugins here as they are built:

  console.log('[Evolve AI] Plugins registered: Databricks, Databricks Connected, dbt, Airflow, pytest, FastAPI, Django, Terraform, Kubernetes, Docker, Jupyter, PyTorch, Security, Git, AWS, GCP, Azure, AWS Connected, GCP Connected, Azure Connected');
}
