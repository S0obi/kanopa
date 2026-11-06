<script setup lang="ts">
import { useForm } from "vee-validate";
import { z } from "zod";
import { Check } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toTypedSchema } from "@/lib/zod-schema";
import { usePartyStore } from "@/stores/party";

const party = usePartyStore();

const schema = toTypedSchema(
  z.object({
    message: z.string().trim().min(1, "Say something!").max(16, "16 characters max"),
  }),
);

const { defineField, errors, meta, handleSubmit, resetForm } = useForm({
  validationSchema: schema,
  initialValues: { message: party.message },
});
const [message, messageAttrs] = defineField("message");

const onSubmit = handleSubmit((values) => {
  party.message = values.message;
  resetForm({ values });
});
</script>

<template>
  <form
    class="w-64 rounded-xl border bg-card/60 p-4 shadow-lg backdrop-blur-xl"
    @submit.prevent="onSubmit"
  >
    <Label for="tada-message" class="mb-2 text-xs text-muted-foreground">Celebration text</Label>
    <div class="flex gap-2">
      <Input
        id="tada-message"
        v-model="message"
        v-bind="messageAttrs"
        :aria-invalid="!!errors.message"
        autocomplete="off"
        class="bg-background/60"
      />
      <Button type="submit" size="icon" :disabled="!meta.dirty" aria-label="Save celebration text">
        <Check />
      </Button>
    </div>
    <p v-if="errors.message" class="mt-1.5 text-xs text-destructive">{{ errors.message }}</p>
  </form>
</template>
