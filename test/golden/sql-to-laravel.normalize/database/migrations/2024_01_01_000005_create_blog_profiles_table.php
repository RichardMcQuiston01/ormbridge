<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_profiles', function (Blueprint $table): void {
            $table->id();
            $table->text('bio')->nullable();
            $table->string('avatar', 100)->nullable();
            $table->foreignId('user_id')->unique()->constrained('blog_users')->cascadeOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_profiles');
    }
};
