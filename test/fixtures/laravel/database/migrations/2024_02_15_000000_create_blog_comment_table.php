<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_comment', function (Blueprint $table) {
            $table->increments('id');
            $table->unsignedInteger('post_id');
            $table->text('body');

            $table->foreign('post_id')->references('id')->on('blog_post')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_comment');
    }
};
