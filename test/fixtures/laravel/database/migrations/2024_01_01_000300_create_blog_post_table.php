<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_post', function (Blueprint $table) {
            $table->increments('id');
            $table->timestampTz('created_at')->useCurrent();
            $table->timestampTz('updated_at')->useCurrent()->useCurrentOnUpdate();
            $table->uuid('public_id')->unique()->default(DB::raw('(gen_random_uuid())'));
            $table->string('title', 200);
            $table->text('body');
            $table->text('excerpt')->nullable();
            $table->enum('status', ['draft', 'published'])->default('draft');
            $table->decimal('rating', 4, 2)->nullable();
            $table->integer('view_count')->default(0);
            $table->boolean('is_featured')->default(false);
            $table->timestampTz('published_at')->useCurrent();
            $table->json('metadata')->default('{}');
            $table->unsignedInteger('author_id');
            $table->unsignedInteger('editor_id')->nullable();
            $table->unsignedInteger('category_id');

            $table->foreign('author_id')->references('id')->on('auth_user')->cascadeOnDelete();
            $table->foreign('editor_id')->references('id')->on('auth_user')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_post');
    }
};
