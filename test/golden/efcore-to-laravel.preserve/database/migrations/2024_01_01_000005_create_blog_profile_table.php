<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('blog_profile', function (Blueprint $table): void {
            $table->bigIncrements('Id');
            $table->text('Bio')->nullable();
            $table->string('Avatar', 100)->nullable();
            $table->foreignId('user_id')
                ->unique()
                ->constrained('auth_user', 'Id')
                ->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('blog_profile');
    }
};
