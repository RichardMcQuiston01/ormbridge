<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('post_tags', function (Blueprint $table): void {
            $table->integer('id')->primary();
            $table->integer('post_id');
            $table->integer('tag_id');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('post_tags');
    }
};
