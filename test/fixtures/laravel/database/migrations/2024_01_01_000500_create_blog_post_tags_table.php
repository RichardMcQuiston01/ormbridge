<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_post_tags', function (Blueprint $table) {
            $table->unsignedInteger('post_id');
            $table->unsignedInteger('tag_id');

            $table->foreign('post_id')->references('id')->on('blog_post')->cascadeOnDelete();
            $table->foreign('tag_id')->references('id')->on('blog_tag')->cascadeOnDelete();
            $table->primary(['post_id', 'tag_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_post_tags');
    }
};
