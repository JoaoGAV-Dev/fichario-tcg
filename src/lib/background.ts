// Coleta diária em segundo plano (Android WorkManager / iOS BGTaskScheduler).
// O sistema decide o horário exato; pedimos a cada ~6h e a função só coleta o que falta hoje.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { refreshDueToday } from './prices';

export const PRICE_TASK = 'fichario-precos-diarios';

TaskManager.defineTask(PRICE_TASK, async () => {
  try {
    await refreshDueToday();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundRefresh(): Promise<'ok' | 'restrito'> {
  const status = await BackgroundTask.getStatusAsync();
  if (status === BackgroundTask.BackgroundTaskStatus.Restricted) return 'restrito';
  if (!(await TaskManager.isTaskRegisteredAsync(PRICE_TASK))) {
    await BackgroundTask.registerTaskAsync(PRICE_TASK, { minimumInterval: 6 * 60 }); // minutos
  }
  return 'ok';
}
