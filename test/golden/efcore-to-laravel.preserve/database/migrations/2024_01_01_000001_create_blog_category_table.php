<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_category', function (Blueprint $table): void {
            $table->bigIncrements('Id');
            $table->string('Name', 100)->unique();
            $table->string('Slug', 50);
            $table->foreignId('parent_id')
                ->nullable()
                ->constrained('blog_category', 'Id')
                ->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_category');
    }
};
