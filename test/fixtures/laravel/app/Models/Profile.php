<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Profile extends Model
{
    protected $table = 'blog_profile';

    public $timestamps = false;

    protected $fillable = ['bio', 'avatar'];

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
